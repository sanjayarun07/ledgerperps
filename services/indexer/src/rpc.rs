use alloy_provider::{Provider, RootProvider};
use serde_json::{json, Value};

/// Thin JSON-RPC wrapper around alloy's HTTP provider. Raw requests keep the surface area small and make the
/// block/log handling independent of alloy's typed-network generics.
#[derive(Clone)]
pub struct Rpc {
    provider: RootProvider,
}

impl Rpc {
    pub fn new(url: &str) -> anyhow::Result<Self> {
        let url = url.parse()?;
        Ok(Self {
            provider: RootProvider::new_http(url),
        })
    }

    pub async fn call(&self, method: &'static str, params: Value) -> anyhow::Result<Value> {
        let v: Value = self.provider.raw_request(method.into(), params).await?;
        Ok(v)
    }

    pub async fn block_number(&self) -> anyhow::Result<u64> {
        let v = self.call("eth_blockNumber", json!([])).await?;
        parse_qty(&v)
    }

    pub async fn chain_id(&self) -> anyhow::Result<u64> {
        let v = self.call("eth_chainId", json!([])).await?;
        parse_qty(&v)
    }

    /// Block header by number. Returns None if the node does not know the block.
    pub async fn block_by_number(&self, n: u64) -> anyhow::Result<Option<Value>> {
        let v = self.call("eth_getBlockByNumber", json!([format!("0x{n:x}"), false])).await?;
        Ok(if v.is_null() { None } else { Some(v) })
    }

    /// Many `eth_getBlockByNumber` calls in ONE JSON-RPC batch request. Result order follows `nums`; a block the node
    /// does not know is `None`; a per-call JSON-RPC error fails the whole batch.
    pub async fn blocks_by_number_batch(&self, nums: &[u64]) -> anyhow::Result<Vec<Option<Value>>> {
        if nums.is_empty() {
            return Ok(vec![]);
        }
        let client = self.provider.client();
        let mut batch = alloy_rpc_client::BatchRequest::new(client);
        let mut waiters = Vec::with_capacity(nums.len());
        for n in nums {
            let w = batch
                .add_call::<_, Value>("eth_getBlockByNumber", &json!([format!("0x{n:x}"), false]))
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            waiters.push(w);
        }
        batch.send().await.map_err(|e| anyhow::anyhow!("batch request failed: {e}"))?;
        let mut out = Vec::with_capacity(nums.len());
        for w in waiters {
            let v = w.await.map_err(|e| anyhow::anyhow!("batch item failed: {e}"))?;
            out.push(if v.is_null() { None } else { Some(v) });
        }
        Ok(out)
    }

    pub async fn transaction_receipt(&self, hash: &str) -> anyhow::Result<Option<Value>> {
        let v = self.call("eth_getTransactionReceipt", json!([hash])).await?;
        Ok(if v.is_null() { None } else { Some(v) })
    }

    pub async fn block_by_tag(&self, tag: &str) -> anyhow::Result<Option<Value>> {
        let v = self.call("eth_getBlockByNumber", json!([tag, false])).await?;
        Ok(if v.is_null() { None } else { Some(v) })
    }

    pub async fn get_logs(&self, from: u64, to: u64, address: &str) -> anyhow::Result<Vec<Value>> {
        let v = self
            .call(
                "eth_getLogs",
                json!([{"fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{to:x}"), "address": address}]),
            )
            .await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    pub async fn eth_call(&self, to: &str, data: &str) -> anyhow::Result<String> {
        let v = self.call("eth_call", json!([{"to": to, "data": data}, "latest"])).await?;
        Ok(v.as_str().unwrap_or("0x").to_string())
    }
}

pub fn parse_qty(v: &Value) -> anyhow::Result<u64> {
    let s = v.as_str().ok_or_else(|| anyhow::anyhow!("expected hex quantity, got {v}"))?;
    Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
}
