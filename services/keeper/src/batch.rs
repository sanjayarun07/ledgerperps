//! Batched read calls. Primary path: Multicall3 `aggregate3` (allowFailure = true), chunked. Fallback path (no Multicall3 on
//! the chain, or a chunk call failed): individual `eth_call`s run in parallel with a concurrency limit.
//! Results always come back in request order, one `Result` per request.
use crate::{chain::CallErr, errors::{classify_revert, RevertKind}};
use alloy::{
    primitives::{address, Address, Bytes},
    sol,
    sol_types::SolCall,
};
use std::{future::Future, sync::Arc};
use tokio::{sync::Semaphore, task::JoinSet};
use tracing::{debug, warn};

sol! {
    interface IMulticall3 {
        struct Call3 { address target; bool allowFailure; bytes callData; }
        struct Res { bool success; bytes returnData; }
        function aggregate3(Call3[] calldata calls) external payable returns (Res[] memory returnData);
    }
}

/// Canonical Multicall3 deployment address (same on virtually every EVM chain; NOT on a fresh hardhat node).
pub const MULTICALL3: Address = address!("cA11bde05977b3631167028862bE2a173976CA11");

/// One raw `eth_call` (no `from`, latest block). Implemented by the real chain client and by test mocks.
pub trait RawCall: Send + Sync + 'static {
    fn raw_call(&self, to: Address, data: Bytes) -> impl Future<Output = Result<Bytes, CallErr>> + Send;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchCfg {
    /// `Some` = use Multicall3 at this address.
    pub multicall: Option<Address>,
    /// Max sub-calls per `aggregate3`.
    pub chunk: usize,
    /// Max in-flight RPC requests (multicall chunks or, in fallback, single calls).
    pub concurrency: usize,
}

async fn singles<C: RawCall>(c: &C, calls: &[(Address, Bytes)]) -> Vec<Result<Bytes, CallErr>> {
    let mut out = Vec::with_capacity(calls.len());
    for (to, data) in calls {
        out.push(c.raw_call(*to, data.clone()).await);
    }
    out
}

async fn multicall_unit<C: RawCall>(c: &C, mc: Address, calls: &[(Address, Bytes)]) -> Vec<Result<Bytes, CallErr>> {
    let req = IMulticall3::aggregate3Call {
        calls: calls.iter().map(|(t, d)| IMulticall3::Call3 { target: *t, allowFailure: true, callData: d.clone() }).collect(),
    };
    let res = match c.raw_call(mc, Bytes::from(req.abi_encode())).await {
        Ok(b) => IMulticall3::aggregate3Call::abi_decode_returns(&b).map_err(|e| format!("decode: {e}")),
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(rs) if rs.len() == calls.len() => rs
            .into_iter()
            .map(|r| if r.success { Ok(r.returnData) } else if r.returnData.is_empty() { Err(CallErr::Revert(RevertKind::NoData)) } else { Err(CallErr::Revert(classify_revert(&r.returnData))) })
            .collect(),
        other => {
            let why = match other { Ok(_) => "result length mismatch".to_string(), Err(e) => e };
            warn!(reason = %why, calls = calls.len(), "multicall chunk failed; falling back to individual calls");
            singles(c, calls).await
        }
    }
}

pub async fn batch_call<C: RawCall>(c: &Arc<C>, cfg: &BatchCfg, calls: Vec<(Address, Bytes)>) -> Vec<Result<Bytes, CallErr>> {
    let n = calls.len();
    if n == 0 {
        return vec![];
    }
    let idx: Vec<usize> = (0..n).collect();
    let units: Vec<Vec<usize>> = match cfg.multicall {
        Some(_) => idx.chunks(cfg.chunk.max(1)).map(|c| c.to_vec()).collect(),
        None => idx.into_iter().map(|i| vec![i]).collect(),
    };
    debug!(calls = n, requests = units.len(), multicall = cfg.multicall.is_some(), "batch read");
    let sem = Arc::new(Semaphore::new(cfg.concurrency.max(1)));
    let mut set = JoinSet::new();
    for unit in units {
        let c = c.clone();
        let sem = sem.clone();
        let mc = cfg.multicall;
        let sub: Vec<(Address, Bytes)> = unit.iter().map(|i| calls[*i].clone()).collect();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore open");
            let res = match mc {
                Some(mc) => multicall_unit(&*c, mc, &sub).await,
                None => singles(&*c, &sub).await,
            };
            (unit, res)
        });
    }
    let mut out: Vec<Option<Result<Bytes, CallErr>>> = (0..n).map(|_| None).collect();
    while let Some(j) = set.join_next().await {
        match j {
            Ok((unit, res)) => {
                for (i, r) in unit.into_iter().zip(res) {
                    out[i] = Some(r);
                }
            }
            Err(e) => warn!(error = %e, "batch task panicked"),
        }
    }
    out.into_iter().map(|o| o.unwrap_or_else(|| Err(CallErr::Transport("batch task lost".into())))).collect()
}

/// Decode the return data of call `T`.
pub fn decode<T: SolCall>(r: Result<Bytes, CallErr>) -> Result<T::Return, CallErr> {
    let b = r?;
    T::abi_decode_returns(&b).map_err(|e| CallErr::Transport(format!("decode {}: {e}", T::SIGNATURE)))
}

#[cfg(test)]
pub mod mock {
    //! In-memory chain used by unit tests: answers calls from a map and emulates Multicall3.
    use super::*;
    use std::{collections::HashMap, sync::atomic::{AtomicUsize, Ordering}};

    pub struct MockCaller {
        pub answers: HashMap<(Address, Bytes), Result<Bytes, Bytes>>, // Err = revert data
        pub has_multicall: bool,
        pub fail_multicall_call: bool,
        pub requests: AtomicUsize,
        pub multicalls: AtomicUsize,
        pub max_inflight: AtomicUsize,
        pub inflight: AtomicUsize,
    }

    impl MockCaller {
        pub fn new(has_multicall: bool) -> MockCaller {
            MockCaller { answers: HashMap::new(), has_multicall, fail_multicall_call: false, requests: 0.into(), multicalls: 0.into(), max_inflight: 0.into(), inflight: 0.into() }
        }
        fn answer(&self, to: Address, data: &Bytes) -> Result<Bytes, Bytes> {
            self.answers.get(&(to, data.clone())).cloned().unwrap_or(Err(Bytes::new()))
        }
    }

    impl RawCall for MockCaller {
        async fn raw_call(&self, to: Address, data: Bytes) -> Result<Bytes, CallErr> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let cur = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_inflight.fetch_max(cur, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            self.inflight.fetch_sub(1, Ordering::SeqCst);
            if to == MULTICALL3 {
                if !self.has_multicall || self.fail_multicall_call {
                    return Err(CallErr::Transport("no multicall".into()));
                }
                self.multicalls.fetch_add(1, Ordering::SeqCst);
                let req = IMulticall3::aggregate3Call::abi_decode(&data).unwrap();
                let rs: Vec<IMulticall3::Res> = req
                    .calls
                    .iter()
                    .map(|c| match self.answer(c.target, &c.callData) {
                        Ok(b) => IMulticall3::Res { success: true, returnData: b },
                        Err(b) => IMulticall3::Res { success: false, returnData: b },
                    })
                    .collect();
                return Ok(Bytes::from(IMulticall3::aggregate3Call::abi_encode_returns(&rs)));
            }
            match self.answer(to, &data) {
                Ok(b) => Ok(b),
                Err(b) if b.is_empty() => Err(CallErr::Revert(RevertKind::NoData)),
                Err(b) => Err(CallErr::Revert(classify_revert(&b))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::MockCaller;
    use super::*;
    use crate::abi::IPerp;
    use alloy::{primitives::U256, sol_types::{SolCall, SolError, SolValue}};
    use std::sync::atomic::Ordering;

    fn target() -> Address { Address::repeat_byte(0x11) }
    fn call(n: u8) -> (Address, Bytes) { (target(), Bytes::from(IPerp::markPriceCall { m: n }.abi_encode())) }

    fn fixture(has_mc: bool, n: u8) -> (Arc<MockCaller>, Vec<(Address, Bytes)>) {
        let mut m = MockCaller::new(has_mc);
        for i in 0..n {
            m.answers.insert(call(i), Ok(Bytes::from(U256::from(1000 + i as u64).abi_encode())));
        }
        // call n reverts OracleDegraded
        m.answers.insert(call(n), Err(Bytes::from(IPerp::OracleDegraded {}.abi_encode())));
        let calls = (0..=n).map(call).collect();
        (Arc::new(m), calls)
    }

    fn check(res: Vec<Result<Bytes, CallErr>>, n: u8) {
        assert_eq!(res.len(), n as usize + 1);
        for i in 0..n {
            let v = decode::<IPerp::markPriceCall>(res[i as usize].clone()).unwrap();
            assert_eq!(v, U256::from(1000 + i as u64), "order preserved at {i}");
        }
        assert!(matches!(res[n as usize], Err(CallErr::Revert(RevertKind::OracleDegraded))));
    }

    #[tokio::test]
    async fn multicall_path_chunks_and_preserves_order_and_reverts() {
        let (m, calls) = fixture(true, 10);
        let cfg = BatchCfg { multicall: Some(MULTICALL3), chunk: 4, concurrency: 2 };
        let res = batch_call(&m, &cfg, calls).await;
        check(res, 10);
        // 11 calls / chunk 4 = 3 aggregate3 requests, no single eth_calls
        assert_eq!(m.multicalls.load(Ordering::SeqCst), 3);
        assert_eq!(m.requests.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn fallback_path_parallel_with_concurrency_limit() {
        let (m, calls) = fixture(false, 12);
        let cfg = BatchCfg { multicall: None, chunk: 4, concurrency: 3 };
        let res = batch_call(&m, &cfg, calls).await;
        check(res, 12);
        assert_eq!(m.requests.load(Ordering::SeqCst), 13);
        let peak = m.max_inflight.load(Ordering::SeqCst);
        assert!(peak > 1 && peak <= 3, "parallel but bounded, peak={peak}");
    }

    #[tokio::test]
    async fn failed_multicall_degrades_to_single_calls() {
        let (m, calls) = fixture(false, 5); // multicall configured but chain has none
        let cfg = BatchCfg { multicall: Some(MULTICALL3), chunk: 100, concurrency: 4 };
        let res = batch_call(&m, &cfg, calls).await;
        check(res, 5);
    }

    #[tokio::test]
    async fn empty_batch() {
        let m = Arc::new(MockCaller::new(true));
        assert!(batch_call(&m, &BatchCfg { multicall: Some(MULTICALL3), chunk: 4, concurrency: 1 }, vec![]).await.is_empty());
    }
}
