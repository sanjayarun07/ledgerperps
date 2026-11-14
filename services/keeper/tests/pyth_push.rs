//! Pyth pusher against real components with fake peers on 127.0.0.1 only: the real `HermesClient` (reqwest) against a local HTTP
//! server that plays Hermes (200/401/429/5xx/garbage/unreachable), and the real alloy-backed `Chain` against the scripted fake node
//! from `tests/common`. No public network is touched.
mod common;
use alloy::{
    primitives::{Bytes, B256, U256},
    sol_types::{SolCall, SolValue},
};
use axum::{extract::State, http::{HeaderMap, StatusCode}, routing::get, Router};
use common::*;
use perp_keeper::{
    abi::IPyth,
    chain::Chain,
    config::{Config, RawConfig, SecretUrl},
    features::pyth_push::{step, ChainPyth, Env, Hermes, HermesClient, HermesError, PythPersist, StepOutcome},
    metrics::Metrics,
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const PYTH: &str = "0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF";
const NOW: u64 = 1_800_000_000;

fn feed(n: u8) -> B256 { B256::repeat_byte(n) }

// ---------------------------------------------------------------------------------------------------------- fake Hermes

type Reply = (u16, Option<(&'static str, &'static str)>, String);

#[derive(Clone)]
struct HState {
    /// (status, extra header, body) served for the next requests; the last one repeats.
    replies: Arc<Mutex<Vec<Reply>>>,
    seen: Arc<Mutex<Vec<(String, HeaderMap)>>>,
}

async fn latest(State(s): State<HState>, uri: axum::http::Uri, headers: HeaderMap) -> (StatusCode, HeaderMap, String) {
    s.seen.lock().unwrap().push((uri.to_string(), headers));
    let (code, extra, body) = {
        let mut r = s.replies.lock().unwrap();
        if r.len() > 1 { r.remove(0) } else { r[0].clone() }
    };
    let mut h = HeaderMap::new();
    if let Some((k, v)) = extra {
        h.insert(k, v.parse().unwrap());
    }
    (StatusCode::from_u16(code).unwrap(), h, body)
}

async fn fake_hermes(replies: Vec<Reply>) -> (String, HState) {
    let st = HState { replies: Arc::new(Mutex::new(replies)), seen: Arc::new(Mutex::new(vec![])) };
    let app = Router::new().route("/v2/updates/price/latest", get(latest)).route("/keyed/v2/updates/price/latest", get(latest)).with_state(st.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}"), st)
}

fn ok_body(times: &[(u8, u64)]) -> String {
    let parsed: Vec<_> = times.iter().map(|(n, t)| json!({"id": format!("{:x}", feed(*n)), "price": {"price": "1", "publish_time": t}})).collect();
    json!({"binary": {"encoding": "hex", "data": ["aabbcc", "ddee"]}, "parsed": parsed}).to_string()
}

fn client(base: &str, key: Option<&str>) -> HermesClient {
    HermesClient::build(&SecretUrl::parse(base).unwrap(), "Authorization", "Bearer ", key, Duration::from_secs(2)).unwrap()
}

#[tokio::test]
async fn hermes_client_success_sends_expected_query_and_api_key_header() {
    let (url, st) = fake_hermes(vec![(200, None, ok_body(&[(1, 77)]))]).await;
    let c = client(&url, Some("test-key-123"));
    let u = c.latest(&[feed(1), feed(2)]).await.unwrap();
    assert_eq!(u.blobs, vec![Bytes::from(vec![0xaa, 0xbb, 0xcc]), Bytes::from(vec![0xdd, 0xee])]);
    assert_eq!(u.publish_times.get(&feed(1)), Some(&77));
    let seen = st.seen.lock().unwrap();
    let (uri, headers) = &seen[0];
    assert!(uri.starts_with("/v2/updates/price/latest?"), "{uri}");
    assert_eq!(uri.matches("ids%5B%5D=").count() + uri.matches("ids[]=").count(), 2, "{uri}");
    assert!(uri.contains(&format!("{:x}", feed(1))) && uri.contains(&format!("{:x}", feed(2))), "{uri}");
    assert!(uri.contains("encoding=hex") && uri.contains("parsed=true"), "{uri}");
    assert!(!uri.contains("0x"), "ids are sent without the 0x prefix: {uri}");
    assert_eq!(headers.get("authorization").unwrap(), "Bearer test-key-123");
    assert!(headers.get("x-api-key").is_none());
}

#[tokio::test]
async fn hermes_client_without_a_key_sends_no_auth_header() {
    let (url, st) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    client(&url, None).latest(&[feed(1)]).await.unwrap();
    assert!(st.seen.lock().unwrap()[0].1.get("authorization").is_none());
}

#[tokio::test]
async fn hermes_client_maps_http_failures_to_typed_errors() {
    for (code, extra, want) in [
        (401u16, None, HermesError::Unauthorized(401)),
        (403, None, HermesError::Unauthorized(403)),
        (429, Some(("retry-after", "42")), HermesError::RateLimited { retry_after_secs: Some(42) }),
        (429, None, HermesError::RateLimited { retry_after_secs: None }),
        (503, None, HermesError::Server(503)),
        (404, None, HermesError::Client(404)),
    ] {
        let (url, _) = fake_hermes(vec![(code, extra, "{\"error\":\"nope\"}".into())]).await;
        assert_eq!(client(&url, None).latest(&[feed(1)]).await.unwrap_err(), want);
    }
    // 200 with garbage
    let (url, _) = fake_hermes(vec![(200, None, "<html>captive portal</html>".into())]).await;
    assert!(matches!(client(&url, None).latest(&[feed(1)]).await.unwrap_err(), HermesError::BadBody(_)));
}

#[tokio::test]
async fn unreachable_hermes_is_an_error_value_not_a_panic_and_does_not_leak_the_url() {
    // nothing listens on this port (bind then drop)
    let port = { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
    let c = client(&format!("http://127.0.0.1:{port}/secret-path-TOKEN"), Some("k"));
    let e = c.latest(&[feed(1)]).await.unwrap_err();
    assert!(matches!(e, HermesError::Network(_)), "{e:?}");
    assert!(!e.to_string().contains("TOKEN"), "{e}");
}

#[tokio::test]
async fn alternative_base_url_with_a_path_prefix_keeps_the_prefix() {
    let (url, st) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    client(&format!("{url}/keyed/"), None).latest(&[feed(1)]).await.unwrap();
    assert!(st.seen.lock().unwrap()[0].0.starts_with("/keyed/v2/updates/price/latest?"));
}

// ---------------------------------------------------------------------------------------------------------- fake chain + step

fn pyth_cfg(hermes_url: &str) -> Config {
    config(&["http://127.0.0.1:1"], |r: &mut RawConfig| {
        r.enable_pyth_push = Some(true);
        r.pyth_contract = Some(PYTH.into());
        r.pyth_feed_ids = Some(vec![format!("BTC={:#x}", feed(1)), format!("ETH={:#x}", feed(2))]);
        r.hermes_url = Some(hermes_url.into());
        r.pyth_jitter_pct = Some(0);
    })
}

/// A fake node that plays the Pyth contract: `publish` = publishTime per feed (a call for an unknown feed reverts).
fn pyth_node_handler(publish: [u64; 2], fee: u64, value_seen: Arc<Mutex<Vec<String>>>) -> Handler {
    handler(move |m, p| match m {
        "eth_call" | "eth_estimateGas" => {
            let tx = &p[0];
            let data = tx.get("input").or_else(|| tx.get("data")).and_then(|v| v.as_str()).unwrap_or("0x");
            let bytes = alloy::hex::decode(data.trim_start_matches("0x")).unwrap();
            if bytes[..4] == IPyth::getPriceUnsafeCall::SELECTOR {
                let call = IPyth::getPriceUnsafeCall::abi_decode(&bytes).unwrap();
                let i = if call.id == feed(1) { 0 } else { 1 };
                let ret = IPyth::Price { price: 5, conf: 1, expo: -8, publishTime: U256::from(publish[i]) };
                return Some(Ok(json!(format!("0x{}", alloy::hex::encode(IPyth::getPriceUnsafeCall::abi_encode_returns(&ret))))));
            }
            if bytes[..4] == IPyth::getUpdateFeeCall::SELECTOR {
                return Some(Ok(json!(format!("0x{}", alloy::hex::encode(U256::from(fee).abi_encode())))));
            }
            if bytes[..4] == IPyth::updatePriceFeedsCall::SELECTOR {
                value_seen.lock().unwrap().push(tx.get("value").and_then(|v| v.as_str()).unwrap_or("0x0").to_string());
                return Some(if m == "eth_call" { Ok(json!("0x")) } else { Ok(json!("0x30d40")) });
            }
            None
        }
        "eth_sendRawTransaction" => Some(Ok(json!(decode_raw(p[0].as_str().unwrap()).0))),
        "eth_getTransactionReceipt" => {
            let h: B256 = p[0].as_str().unwrap().parse().unwrap();
            Some(Ok(receipt(h, true)))
        }
        _ => None,
    })
}

async fn run_step(cfg: &Config, node_url: &str, hermes: &HermesClient, dry_run: bool, with_signer: bool) -> (StepOutcome, PythPersist, Metrics) {
    let chain = Chain::connect(&config(&[node_url], |r| r.dry_run = Some(dry_run)), with_signer.then(signer)).await.unwrap();
    let pc = ChainPyth { chain: &chain, pyth: cfg.pyth.contract };
    let metrics = Metrics::new();
    let mut st = PythPersist::default();
    let env = Env { cfg: &cfg.pyth, metrics: &metrics, dry_run, force: false, native_usd_micro: 1_000_000_000, min_profit_micro: 0 };
    let out = step(&env, &mut st, hermes, &pc, NOW, NOW, 0).await;
    (out, st, metrics)
}

#[tokio::test]
async fn end_to_end_stale_feed_is_pushed_with_value_equal_to_the_fee() {
    let (hurl, _) = fake_hermes(vec![(200, None, ok_body(&[(1, NOW - 1), (2, NOW - 1)]))]).await;
    let value_seen = Arc::new(Mutex::new(vec![]));
    let node = spawn(pyth_node_handler([NOW - 4000, NOW - 10], 7, value_seen.clone())).await;
    let cfg = pyth_cfg(&hurl);
    let (out, st, metrics) = run_step(&cfg, &node.url, &client(&hurl, None), false, true).await;
    assert!(matches!(out, StepOutcome::Sent { fee: 7, .. }), "{out:?}");
    assert_eq!(node.count("eth_sendRawTransaction"), 1);
    // simulation, gas estimate (and the real send's own estimate) all carried value = 7 wei
    let v = value_seen.lock().unwrap();
    assert!(v.len() >= 2 && v.iter().all(|x| x == "0x7"), "{v:?}");
    assert_eq!(st.pushes, 1);
    assert!(st.spent_in_window(NOW) > 7);
    let m = metrics.render();
    assert!(m.contains("keeper_pyth_push_total{result=\"sent\"} 1") && m.contains("keeper_pyth_fee_wei_total 7"), "{m}");
    assert!(m.contains("keeper_pyth_age_seconds{feed=\"BTC\"} 4000"), "{m}");
}

#[tokio::test]
async fn end_to_end_fresh_prices_make_no_hermes_request_and_no_transaction() {
    let (hurl, hst) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    let node = spawn(pyth_node_handler([NOW - 30, NOW - 10], 7, Default::default())).await;
    let (out, _, _) = run_step(&pyth_cfg(&hurl), &node.url, &client(&hurl, None), false, true).await;
    assert_eq!(out, StepOutcome::Fresh);
    assert!(hst.seen.lock().unwrap().is_empty());
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
}

#[tokio::test]
async fn end_to_end_dry_run_with_a_key_simulates_and_never_broadcasts() {
    let (hurl, _) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    let node = spawn(pyth_node_handler([NOW - 4000, NOW - 10], 7, Default::default())).await;
    let (out, st, _) = run_step(&pyth_cfg(&hurl), &node.url, &client(&hurl, None), true, true).await;
    assert_eq!(out, StepOutcome::DryRun { fee: 7 });
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
    assert!(st.ledger.is_empty());
}

#[tokio::test]
async fn end_to_end_dry_run_without_any_key_still_plans() {
    let (hurl, _) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    let node = spawn(pyth_node_handler([NOW - 4000, NOW - 10], 7, Default::default())).await;
    let (out, _, _) = run_step(&pyth_cfg(&hurl), &node.url, &client(&hurl, None), true, false).await;
    assert_eq!(out, StepOutcome::DryRun { fee: 7 });
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
}

#[tokio::test]
async fn end_to_end_hermes_401_backs_off_and_the_chain_is_untouched() {
    let (hurl, _) = fake_hermes(vec![(401, None, "unauthorized".into())]).await;
    let node = spawn(pyth_node_handler([NOW - 4000, NOW - 10], 7, Default::default())).await;
    let (out, st, metrics) = run_step(&pyth_cfg(&hurl), &node.url, &client(&hurl, None), false, true).await;
    assert_eq!(out, StepOutcome::HermesFailed { kind: "unauthorized", backoff_secs: 60 });
    assert_eq!(st.next_run_unix, NOW + 60);
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
    assert!(metrics.render().contains("keeper_pyth_hermes_errors_total{kind=\"unauthorized\"} 1"));
}

#[tokio::test]
async fn end_to_end_pyth_revert_in_simulation_blocks_the_send() {
    let (hurl, _) = fake_hermes(vec![(200, None, ok_body(&[]))]).await;
    let h = pyth_node_handler([NOW - 4000, NOW - 10], 7, Default::default());
    let node = spawn(handler(move |m, p| {
        if m == "eth_call" {
            let data = p[0].get("input").or_else(|| p[0].get("data")).and_then(|v| v.as_str()).unwrap_or("");
            if data.starts_with(&format!("0x{}", alloy::hex::encode(IPyth::updatePriceFeedsCall::SELECTOR))) {
                return Some(Err((3, "execution reverted".into())));
            }
        }
        h(m, p)
    }))
    .await;
    let (out, _, metrics) = run_step(&pyth_cfg(&hurl), &node.url, &client(&hurl, None), false, true).await;
    assert!(matches!(out, StepOutcome::SimFailed { .. } | StepOutcome::RpcFailed), "{out:?}");
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
    let m = metrics.render();
    assert!(m.contains("result=\"failed_sim\"") || m.contains("result=\"failed_rpc\""), "{m}");
}
