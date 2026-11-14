//! Minimal scriptable JSON-RPC-over-HTTP server for integration tests (real alloy stack, fake node).
#![allow(dead_code)]
use alloy::{
    consensus::{Transaction, TxEnvelope},
    eips::eip2718::Decodable2718,
    primitives::{keccak256, Address, B256},
};
use axum::{extract::State, http::StatusCode, routing::post, Router};
use perp_keeper::config::{Config, RawConfig};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

/// `Some(Ok(v))` = JSON-RPC result, `Some(Err((code,msg)))` = JSON-RPC error, `None` = fall through to defaults.
pub type Handler = Arc<dyn Fn(&str, &Value) -> Option<Result<Value, (i64, String)>> + Send + Sync>;

pub struct Mock {
    pub url: String,
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
    /// While true every HTTP request gets a 500.
    pub down: Arc<AtomicBool>,
}

impl Mock {
    pub fn count(&self, method: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == method).count()
    }
    pub fn params(&self, method: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }
}

#[derive(Clone)]
struct S {
    handler: Handler,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    down: Arc<AtomicBool>,
}

fn default_result(method: &str) -> Result<Value, (i64, String)> {
    match method {
        "eth_chainId" => Ok(json!("0x7a69")),
        "eth_blockNumber" => Ok(json!("0x64")),
        "eth_getCode" => Ok(json!("0x6001")),
        "eth_estimateGas" => Ok(json!("0x30d40")),
        "eth_gasPrice" => Ok(json!("0x3b9aca00")),
        "eth_feeHistory" | "eth_maxPriorityFeePerGas" => Err((-32601, "method not found".into())),
        "eth_getTransactionCount" => Ok(json!("0x0")),
        "eth_getTransactionReceipt" => Ok(Value::Null),
        _ => Err((-32601, format!("mock: unhandled {method}"))),
    }
}

async fn serve_one(s: &S, req: &Value) -> Value {
    let method = req["method"].as_str().unwrap_or("");
    let params = req["params"].clone();
    s.calls.lock().unwrap().push((method.to_string(), params.clone()));
    let r = (s.handler)(method, &params).unwrap_or_else(|| default_result(method));
    match r {
        Ok(v) => json!({"jsonrpc":"2.0","id":req["id"],"result":v}),
        Err((c, m)) => json!({"jsonrpc":"2.0","id":req["id"],"error":{"code":c,"message":m}}),
    }
}

async fn rpc(State(s): State<S>, body: axum::body::Bytes) -> (StatusCode, [(&'static str, &'static str); 1], String) {
    let ct = [("content-type", "application/json")];
    if s.down.load(Ordering::SeqCst) {
        return (StatusCode::INTERNAL_SERVER_ERROR, ct, "upstream exploded".into());
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let out = if let Some(arr) = req.as_array() {
        let mut v = vec![];
        for r in arr {
            v.push(serve_one(&s, r).await);
        }
        Value::Array(v)
    } else {
        serve_one(&s, &req).await
    };
    (StatusCode::OK, ct, out.to_string())
}

pub async fn spawn(handler: Handler) -> Mock {
    let calls = Arc::new(Mutex::new(vec![]));
    let down = Arc::new(AtomicBool::new(false));
    let s = S { handler, calls: calls.clone(), down: down.clone() };
    let app = Router::new().route("/", post(rpc)).with_state(s);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app).await.unwrap();
    });
    Mock { url: format!("http://{addr}"), calls, down }
}

pub fn handler(f: impl Fn(&str, &Value) -> Option<Result<Value, (i64, String)>> + Send + Sync + 'static) -> Handler {
    Arc::new(f)
}

pub const EXCHANGE: &str = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/// Hardhat dev account #0 key (public test key).
pub const TEST_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

pub fn config(urls: &[&str], edit: impl FnOnce(&mut RawConfig)) -> Config {
    let mut r = RawConfig {
        rpc_urls: Some(urls.iter().map(|s| s.to_string()).collect()),
        exchange: Some(EXCHANGE.into()),
        tx_timeout_secs: Some(1),
        max_bump_attempts: Some(3),
        gas_bump_pct: Some(20),
        ..Default::default()
    };
    edit(&mut r);
    Config::from_raw(r).unwrap()
}

pub fn signer() -> alloy::signers::local::PrivateKeySigner {
    TEST_KEY.parse().unwrap()
}

/// Decode a raw EIP-2718 tx as sent via eth_sendRawTransaction: (hash, nonce, max_fee_per_gas, max_priority_fee).
pub fn decode_raw(raw_hex: &str) -> (B256, u64, u128, u128) {
    let bytes = alloy::hex::decode(raw_hex.trim_start_matches("0x")).unwrap();
    let env = TxEnvelope::decode_2718(&mut &bytes[..]).unwrap();
    (keccak256(&bytes), env.nonce(), env.max_fee_per_gas(), env.max_priority_fee_per_gas().unwrap_or(0))
}

pub fn receipt(hash: B256, ok: bool) -> Value {
    json!({
        "transactionHash": hash, "transactionIndex": "0x0", "blockHash": format!("0x{}", "11".repeat(32)), "blockNumber": "0x65",
        "from": format!("{:#x}", signer().address()), "to": EXCHANGE, "cumulativeGasUsed": "0x30d40", "gasUsed": "0x2ee00",
        "contractAddress": null, "logs": [], "logsBloom": format!("0x{}", "00".repeat(256)), "type": "0x2",
        "status": if ok { "0x1" } else { "0x0" }, "effectiveGasPrice": "0x3b9aca00"
    })
}

pub fn addr_of(params: &Value) -> Option<Address> {
    params.get(0)?.as_str()?.parse().ok()
}
