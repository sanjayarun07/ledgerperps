//! Exercises the real alloy-backed `Chain` against a scripted fake node: fee-bump replacement, nonce recovery,
//! RPC failover + health check, private raw-tx endpoint, Multicall3 detection/batching.
mod common;
use alloy::{
    primitives::{Address, Bytes, B256, U256},
    sol_types::{SolCall, SolValue},
};
use common::*;
use perp_keeper::{
    abi::IPerp,
    batch::{IMulticall3, MULTICALL3},
    chain::{Chain, SendError},
};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};

type Raw = (B256, u64, u128, u128);

fn calldata() -> Bytes { Bytes::from(IPerp::pokeFundingCall { m: 0 }.abi_encode()) }

#[tokio::test]
async fn unmined_tx_is_replaced_at_the_same_nonce_with_bumped_fees() {
    let raws: Arc<Mutex<Vec<Raw>>> = Arc::new(Mutex::new(vec![]));
    let r2 = raws.clone();
    let node = spawn(handler(move |m, p| match m {
        "eth_getTransactionCount" => Some(Ok(json!("0x7"))),
        "eth_sendRawTransaction" => {
            let d = decode_raw(p[0].as_str().unwrap());
            r2.lock().unwrap().push(d);
            Some(Ok(json!(d.0)))
        }
        // only the SECOND submission (the replacement) ever gets mined
        "eth_getTransactionReceipt" => {
            let want = r2.lock().unwrap().get(1).map(|t| t.0);
            let asked: B256 = p[0].as_str().unwrap().parse().unwrap();
            Some(Ok(if want == Some(asked) { receipt(asked, true) } else { Value::Null }))
        }
        _ => None,
    }))
    .await;
    let cfg = config(&[&node.url], |_| {});
    let chain = Chain::connect(&cfg, Some(signer())).await.unwrap();
    let sent = chain.execute("test", calldata()).await.expect("replacement mined");
    assert_eq!(sent.attempts, 2);
    assert_eq!(sent.effective_gas_price, 1_000_000_000);
    let raws = raws.lock().unwrap();
    assert_eq!(raws.len(), 2);
    assert_eq!(raws[0].1, 7);
    assert_eq!(raws[1].1, 7, "replacement reuses the nonce");
    // base fee 1 gwei, +20% per attempt (>= the 10% nodes require)
    assert_eq!(raws[0].2, 1_000_000_000);
    assert_eq!(raws[1].2, 1_200_000_000);
    assert!(raws[1].3 > raws[0].3, "tip bumped as well: {} -> {}", raws[0].3, raws[1].3);
    assert_eq!(sent.hash, raws[1].0);
}

#[tokio::test]
async fn gives_up_after_max_attempts_and_forgets_the_nonce() {
    let node = spawn(handler(move |m, p| match m {
        "eth_sendRawTransaction" => Some(Ok(json!(decode_raw(p[0].as_str().unwrap()).0))),
        _ => None, // receipts stay null
    }))
    .await;
    let cfg = config(&[&node.url], |r| r.max_bump_attempts = Some(2));
    let chain = Chain::connect(&cfg, Some(signer())).await.unwrap();
    match chain.execute("test", calldata()).await {
        Err(SendError::Timeout(2, h)) => assert_eq!(h.len(), 2),
        other => panic!("expected timeout, got {other:?}"),
    }
    // nonce cache dropped => the next execute asks the node again
    let before = node.count("eth_getTransactionCount");
    let _ = chain.execute("test", calldata()).await;
    assert_eq!(node.count("eth_getTransactionCount"), before + 1);
}

#[tokio::test]
async fn max_fee_cap_refuses_to_bid() {
    let node = spawn(handler(|m, _| (m == "eth_gasPrice").then(|| Ok(json!("0x2540be400"))))).await; // 10 gwei
    let cfg = config(&[&node.url], |r| r.max_fee_gwei = Some(5));
    let chain = Chain::connect(&cfg, Some(signer())).await.unwrap();
    assert!(matches!(chain.execute("t", calldata()).await, Err(SendError::FeeCap)));
    assert_eq!(node.count("eth_sendRawTransaction"), 0);
}

#[tokio::test]
async fn stale_nonce_is_resynced_and_the_send_retried_once() {
    let txcount_calls = Arc::new(AtomicUsize::new(0));
    let sends = Arc::new(AtomicUsize::new(0));
    let nonces: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(vec![]));
    let (tc, sd, ns) = (txcount_calls.clone(), sends.clone(), nonces.clone());
    let node = spawn(handler(move |m, p| match m {
        // first read says 5 (stale), after the resync the node says 9
        "eth_getTransactionCount" => Some(Ok(json!(if tc.fetch_add(1, Ordering::SeqCst) == 0 { "0x5" } else { "0x9" }))),
        "eth_sendRawTransaction" => {
            let d = decode_raw(p[0].as_str().unwrap());
            ns.lock().unwrap().push(d.1);
            if sd.fetch_add(1, Ordering::SeqCst) == 0 {
                Some(Err((-32000, "nonce too low: next nonce 9, tx nonce 5".into())))
            } else {
                Some(Ok(json!(d.0)))
            }
        }
        "eth_getTransactionReceipt" => Some(Ok(receipt(p[0].as_str().unwrap().parse().unwrap(), true))),
        _ => None,
    }))
    .await;
    let chain = Chain::connect(&config(&[&node.url], |_| {}), Some(signer())).await.unwrap();
    let sent = chain.execute("test", calldata()).await.expect("recovered");
    assert_eq!(sent.attempts, 1);
    assert_eq!(*nonces.lock().unwrap(), vec![5, 9], "retried with the node's nonce");
    assert_eq!(txcount_calls.load(Ordering::SeqCst), 2);
    // the local cache then advances without asking the node again
    let _ = chain.execute("test", calldata()).await;
    assert_eq!(*nonces.lock().unwrap().last().unwrap(), 10);
    assert_eq!(txcount_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn persistent_nonce_error_fails_after_one_resync() {
    let node = spawn(handler(|m, _| match m {
        "eth_sendRawTransaction" => Some(Err((-32000, "nonce too low".into()))),
        _ => None,
    }))
    .await;
    let chain = Chain::connect(&config(&[&node.url], |_| {}), Some(signer())).await.unwrap();
    assert!(matches!(chain.execute("t", calldata()).await, Err(SendError::Rpc(_))));
    assert_eq!(node.count("eth_sendRawTransaction"), 2, "exactly one retry");
}

#[tokio::test]
async fn revert_during_send_is_reported_as_revert_not_rpc_error() {
    let node = spawn(handler(|m, _| match m {
        "eth_estimateGas" => Some(Err((3, "execution reverted".into()))),
        _ => None,
    }))
    .await;
    let chain = Chain::connect(&config(&[&node.url], |_| {}), Some(signer())).await.unwrap();
    assert!(matches!(chain.execute("t", calldata()).await, Err(SendError::Reverted(_))));
}

#[tokio::test]
async fn rpc_failover_rotates_on_http_failure_and_fails_back_after_health_check() {
    let a = spawn(handler(|_, _| None)).await;
    let b = spawn(handler(|_, _| None)).await;
    a.down.store(true, std::sync::atomic::Ordering::SeqCst); // primary is dead from the start
    let cfg = config(&[&a.url, &b.url], |_| {});
    let chain = Chain::connect(&cfg, None).await.expect("connects through the backup");
    assert_eq!(chain.active_endpoint(), 1);
    assert!(b.count("eth_chainId") >= 1);
    // keeps working on B
    chain.head().await.ok(); // may fail on block parse; we only care that requests reach B
    let b_before = b.calls.lock().unwrap().len();
    chain.market_count().await.ok();
    assert!(b.calls.lock().unwrap().len() > b_before);
    // health check while A is still down: stays on B
    assert_eq!(chain.health_check().await, 1);
    // A recovers: probe sees both at the same head and fails back to the preferred endpoint
    a.down.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(chain.health_check().await, 0);
    assert_eq!(chain.active_endpoint(), 0);
}

#[tokio::test]
async fn lagging_endpoint_is_demoted_by_the_health_check() {
    let a = spawn(handler(|m, _| (m == "eth_blockNumber").then(|| Ok(json!("0x10"))))).await; // 16
    let b = spawn(handler(|m, _| (m == "eth_blockNumber").then(|| Ok(json!("0x64"))))).await; // 100
    let chain = Chain::connect(&config(&[&a.url, &b.url], |r| r.rpc_max_lag_blocks = Some(5)), None).await.unwrap();
    assert_eq!(chain.health_check().await, 1);
}

#[tokio::test]
async fn raw_transactions_go_to_the_private_endpoint_only() {
    let public = spawn(handler(|m, p| match m {
        "eth_getTransactionReceipt" => Some(Ok(receipt(p[0].as_str().unwrap().parse().unwrap(), true))),
        _ => None,
    }))
    .await;
    let private = spawn(handler(|m, p| match m {
        "eth_sendRawTransaction" => Some(Ok(json!(decode_raw(p[0].as_str().unwrap()).0))),
        _ => None,
    }))
    .await;
    let cfg = config(&[&public.url], |r| r.send_raw_via = Some(private.url.clone()));
    let chain = Chain::connect(&cfg, Some(signer())).await.unwrap();
    assert!(chain.private_relay_enabled());
    let sent = chain.execute("test", calldata()).await.unwrap();
    assert_eq!(private.count("eth_sendRawTransaction"), 1);
    assert_eq!(public.count("eth_sendRawTransaction"), 0, "nothing leaks to the public mempool endpoint");
    assert_eq!(sent.hash, decode_raw(private.params("eth_sendRawTransaction")[0][0].as_str().unwrap()).0);
}

fn positions_return(size: i64) -> Bytes {
    // (int256 size, int256 basis, int256 lastFundingIdx, bool isolated, int256 isoMargin, uint256 isoReserved)
    Bytes::from((alloy::primitives::I256::try_from(size).unwrap(), alloy::primitives::I256::ZERO, alloy::primitives::I256::ZERO, false, alloy::primitives::I256::ZERO, U256::ZERO).abi_encode_params())
}

/// Fake node that implements `positions(a, m)` (size = m + 1) and Multicall3 (when `mc` is true).
fn chain_logic(mc: bool) -> common::Handler {
    handler(move |m, p| match m {
        "eth_getCode" => {
            let a = addr_of(p).unwrap();
            Some(Ok(json!(if a == MULTICALL3 && !mc { "0x" } else { "0x6001" })))
        }
        "eth_call" => {
            let to: Address = p[0]["to"].as_str().unwrap().parse().unwrap();
            let data: Bytes = p[0].get("input").or(p[0].get("data")).unwrap().as_str().unwrap().parse().unwrap();
            let answer = |d: &[u8]| -> Bytes {
                let c = IPerp::positionsCall::abi_decode(d).unwrap();
                positions_return(c.market as i64 + 1)
            };
            if to == MULTICALL3 {
                let req = IMulticall3::aggregate3Call::abi_decode(&data).unwrap();
                let rs: Vec<_> = req.calls.iter().map(|c| IMulticall3::Res { success: true, returnData: answer(&c.callData) }).collect();
                Some(Ok(json!(Bytes::from(IMulticall3::aggregate3Call::abi_encode_returns(&rs)))))
            } else {
                Some(Ok(json!(answer(&data))))
            }
        }
        _ => None,
    })
}

#[tokio::test]
async fn multicall_auto_detected_and_used_for_batched_reads() {
    let node = spawn(chain_logic(true)).await;
    let chain = Chain::connect(&config(&[&node.url], |_| {}), None).await.unwrap();
    assert!(chain.multicall_enabled());
    let acct = B256::repeat_byte(1);
    let reqs: Vec<(B256, u8)> = (0..5).map(|m| (acct, m)).collect();
    let res = chain.read_positions(&reqs).await;
    let sizes: Vec<i64> = res.iter().map(|r| r.as_ref().unwrap().size.as_i64()).collect();
    assert_eq!(sizes, vec![1, 2, 3, 4, 5]);
    assert_eq!(node.count("eth_call"), 1, "five reads, one aggregate3 request");
}

#[tokio::test]
async fn without_multicall_reads_fall_back_to_parallel_single_calls() {
    let node = spawn(chain_logic(false)).await;
    let chain = Chain::connect(&config(&[&node.url], |r| r.rpc_concurrency = Some(2)), None).await.unwrap();
    assert!(!chain.multicall_enabled());
    let reqs: Vec<(B256, u8)> = (0..5).map(|m| (B256::repeat_byte(1), m)).collect();
    let sizes: Vec<i64> = chain.read_positions(&reqs).await.iter().map(|r| r.as_ref().unwrap().size.as_i64()).collect();
    assert_eq!(sizes, vec![1, 2, 3, 4, 5]);
    assert_eq!(node.count("eth_call"), 5);
}

#[tokio::test]
async fn multicall_modes_on_and_off() {
    let node = spawn(chain_logic(false)).await;
    // `on` without a deployment is a startup error, not a silent downgrade
    let err = Chain::connect(&config(&[&node.url], |r| r.multicall = Some("on".into())), None).await.err().expect("must fail");
    assert!(err.to_string().contains("multicall=on"), "{err}");
    // `off` never even looks
    let node2 = spawn(chain_logic(true)).await;
    let chain = Chain::connect(&config(&[&node2.url], |r| r.multicall = Some("off".into())), None).await.unwrap();
    assert!(!chain.multicall_enabled());
}

#[tokio::test]
async fn broken_multicall_chunk_degrades_to_single_calls_over_real_http() {
    // chain says Multicall3 exists but aggregate3 itself errors (e.g. gas limit): results must still be right
    let base = chain_logic(true);
    let node = spawn(handler(move |m, p| {
        if m == "eth_call" && p[0]["to"].as_str().unwrap().eq_ignore_ascii_case(&format!("{MULTICALL3:#x}")) {
            return Some(Err((-32000, "out of gas".into())));
        }
        base(m, p)
    }))
    .await;
    let chain = Chain::connect(&config(&[&node.url], |_| {}), None).await.unwrap();
    assert!(chain.multicall_enabled());
    let reqs: Vec<(B256, u8)> = (0..3).map(|m| (B256::repeat_byte(1), m)).collect();
    let sizes: Vec<i64> = chain.read_positions(&reqs).await.iter().map(|r| r.as_ref().unwrap().size.as_i64()).collect();
    assert_eq!(sizes, vec![1, 2, 3]);
}
