//! LIVE Hermes contract test. SKIPPED (passes without doing anything) unless `PYTH_LIVE_TEST=1` and `HERMES_API_KEY` are set.
//! It makes ONE real HTTPS request and sends nothing to any chain. Run it yourself:
//!
//!   PYTH_LIVE_TEST=1 HERMES_API_KEY=<key> cargo test --test hermes_live -- --nocapture
//!
//! Optional: `HERMES_URL` (default https://pyth.dourolabs.app/hermes). The key is sent as `Authorization: Bearer <key>` and never printed.
use alloy::primitives::B256;
use perp_keeper::{
    config::{SecretUrl, DEFAULT_HERMES_URL},
    features::pyth_push::{Hermes, HermesClient},
};
use std::{str::FromStr, time::Duration};

/// Pyth BTC/USD feed id (same as infra/testnet/testnet.config.json).
const BTC: &str = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

#[tokio::test]
async fn live_hermes_returns_a_fresh_btc_price_in_the_expected_format() {
    let key = std::env::var("HERMES_API_KEY").unwrap_or_default();
    if std::env::var("PYTH_LIVE_TEST").as_deref() != Ok("1") || key.trim().is_empty() {
        eprintln!("hermes_live: skipped (set PYTH_LIVE_TEST=1 and HERMES_API_KEY to run)");
        return;
    }
    let base = std::env::var("HERMES_URL").unwrap_or_else(|_| DEFAULT_HERMES_URL.into());
    let c = HermesClient::build(&SecretUrl::parse(&base).unwrap(), "Authorization", "Bearer ", Some(key.trim()), Duration::from_secs(15)).unwrap();
    let id = B256::from_str(BTC).unwrap();
    let u = c.latest(&[id]).await.unwrap_or_else(|e| panic!("live Hermes request failed ({}): {e}", c.endpoint()));
    assert!(!u.blobs.is_empty() && u.blobs.iter().all(|b| !b.is_empty()), "binary.data[] must hold hex update blobs");
    let t = *u.publish_times.get(&id).expect("parsed[0].price.publish_time for BTC");
    let (price, conf, expo) = *u.prices.get(&id).expect("parsed[0].price.{price,conf,expo}");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert!(now.abs_diff(t) < 300, "publish_time {t} is not fresh (now {now})");
    assert!(price > 0 && conf > 0 && (-12..=0).contains(&expo), "price={price} conf={conf} expo={expo}");
    let usd = price as f64 * 10f64.powi(expo);
    assert!((1_000.0..10_000_000.0).contains(&usd), "BTC price {usd} looks wrong");
    eprintln!("hermes_live OK: BTC={usd:.2} USD (expo {expo}), age {}s, {} blob(s)", now.saturating_sub(t), u.blobs.len());
}
