//! Chain access: typed views, batched reads, log scanning, simulation (eth_call), and transaction submission with nonce
//! management and fee-bump replacement. Everything the keeper sends goes through `Chain::execute`.
use crate::{
    abi::IPerp,
    batch::{batch_call, decode, BatchCfg, RawCall},
    config::{Config, MulticallMode},
    errors::{classify_revert, RevertKind},
    profit::LiqParams,
    rpc_pool::{FailoverTransport, Selector},
    scanner::ScanSource,
    tx::{bump_fee, fee_for_attempt, gas_with_buffer, gwei_to_wei, send_error_action, NonceTracker, SendAction},
};
use alloy::{
    eips::eip2718::Encodable2718,
    network::{EthereumWallet, NetworkTransactionBuilder, TransactionBuilder},
    primitives::{Address, Bytes, B256, I256, U256, U64},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::{
        client::RpcClient,
        types::{BlockNumberOrTag, Filter, Log, TransactionRequest},
    },
    signers::local::PrivateKeySigner,
    sol_types::SolCall,
    transports::{RpcError, TransportError, TransportErrorKind},
};
use anyhow::{anyhow, bail, Context, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// Why a simulation or view call did not succeed.
#[derive(Debug, Clone)]
pub enum CallErr {
    Revert(RevertKind),
    Transport(String),
}

impl std::fmt::Display for CallErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallErr::Revert(k) => write!(f, "revert({})", k.label()),
            CallErr::Transport(s) => write!(f, "transport: {s}"),
        }
    }
}

pub fn from_transport(e: &TransportError) -> CallErr {
    if let RpcError::ErrorResp(p) = e {
        if let Some(d) = p.as_revert_data() {
            return CallErr::Revert(classify_revert(&d));
        }
        // execution reverted with no data (e.g. plain `revert()`)
        if p.message.to_ascii_lowercase().contains("revert") {
            return CallErr::Revert(RevertKind::NoData);
        }
    }
    CallErr::Transport(e.to_string())
}

fn from_contract(e: alloy::contract::Error) -> CallErr {
    if let Some(d) = e.as_revert_data() {
        return CallErr::Revert(classify_revert(&d));
    }
    CallErr::Transport(e.to_string())
}

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub number: u64,
    pub timestamp: u64,
}

#[derive(Debug)]
pub struct Sent {
    pub hash: B256,
    pub gas_used: u64,
    pub block: u64,
    pub attempts: u32,
    /// Receipt's effective gas price (wei); `gas_used * effective_gas_price` is the real cost.
    pub effective_gas_price: u128,
}

impl Sent {
    pub fn cost_wei(&self) -> u128 { (self.gas_used as u128).saturating_mul(self.effective_gas_price) }
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("simulation/estimate reverted: {0}")]
    Reverted(RevertKind),
    #[error("dry-run or no signer: refusing to send")]
    NoSigner,
    #[error("fee above configured cap")]
    FeeCap,
    #[error("transaction mined but reverted: {0:?}")]
    MinedRevert(B256),
    #[error("not mined after {0} attempts: {1:?}")]
    Timeout(u32, Vec<B256>),
    #[error("rpc: {0}")]
    Rpc(String),
}

/// The few `getMarket` fields the keeper needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketInfo {
    pub lot: u64,
    pub funding_interval: u32,
}

/// Word index of `lot` / `fundingInterval` in the `Market` struct returned by `getMarket` (see contracts/abi). Checked
/// against the merged ABI by `tests/abi_drift.rs`.
pub const MARKET_LOT_WORD: usize = 4;
pub const MARKET_FUNDING_INTERVAL_WORD: usize = 12;

fn word(b: &[u8], idx: usize) -> Option<&[u8]> {
    b.get(idx * 32..idx * 32 + 32)
}

fn low_u64(w: &[u8]) -> Option<u64> {
    (w[..24].iter().all(|x| *x == 0)).then(|| u64::from_be_bytes(w[24..].try_into().expect("8 bytes")))
}

/// Parse the ABI-encoded `getMarket` return (a single dynamic tuple: word 0 = offset, then the tuple's head words).
pub fn parse_market_info(b: &[u8]) -> Option<MarketInfo> {
    let off = low_u64(word(b, 0)?)? as usize;
    if !off.is_multiple_of(32) {
        return None;
    }
    let body = b.get(off..)?;
    let lot = low_u64(word(body, MARKET_LOT_WORD)?)?;
    let fi = low_u64(word(body, MARKET_FUNDING_INTERVAL_WORD)?)?;
    Some(MarketInfo { lot, funding_interval: u32::try_from(fi).ok()? })
}

/// Plain `eth_call` client used by the batcher (no `from`, latest block).
pub struct CallClient {
    provider: DynProvider,
}

impl RawCall for CallClient {
    async fn raw_call(&self, to: Address, data: Bytes) -> Result<Bytes, CallErr> {
        self.provider.call(TransactionRequest::default().with_to(to).with_input(data)).await.map_err(|e| from_transport(&e))
    }
}

pub struct Chain {
    pub provider: DynProvider,
    pub exchange: Address,
    /// Address used as `from` for simulations (the signer address, or a placeholder in dry-run without a key).
    pub from: Address,
    can_send: bool,
    wallet: Option<EthereumWallet>,
    /// Optional private/relay endpoint that receives the signed raw transactions instead of the public RPC.
    private: Option<DynProvider>,
    nonce: Mutex<NonceTracker>,
    tx_timeout: Duration,
    max_attempts: u32,
    bump_pct: u64,
    buffer_pct: u64,
    max_fee_wei: u128,
    chain_id: u64,
    selector: Arc<StdMutex<Selector>>,
    probes: Vec<RpcClient>,
    caller: Arc<CallClient>,
    batch_cfg: BatchCfg,
    market_cache: StdMutex<HashMap<u8, (Instant, MarketInfo)>>,
}

impl Chain {
    pub async fn connect(cfg: &Config, signer: Option<PrivateKeySigner>) -> Result<Chain> {
        let urls = cfg
            .rpc_urls
            .iter()
            .map(|u| u.parse::<alloy::transports::http::reqwest::Url>().map_err(|e| anyhow!("invalid rpc url `{u}`: {e}")))
            .collect::<Result<Vec<_>>>()?;
        let (transport, selector) = FailoverTransport::new(&urls, Duration::from_secs(cfg.rpc_cooldown_secs), cfg.rpc_max_lag_blocks);
        let client = RpcClient::new(transport, false);
        let (provider, wallet, from, can_send) = match signer {
            Some(s) => {
                let addr = s.address();
                let w = EthereumWallet::from(s);
                (ProviderBuilder::new().wallet(w.clone()).connect_client(client).erased(), Some(w), addr, !cfg.dry_run)
            }
            None => (ProviderBuilder::new().connect_client(client).erased(), None, Address::repeat_byte(0xde), false),
        };
        let chain_id = provider.get_chain_id().await.context("eth_chainId (is any RPC reachable?)")?;
        let code = provider.get_code_at(cfg.exchange).await.context("eth_getCode")?;
        if code.is_empty() {
            return Err(anyhow!("no contract code at exchange address {} on chain {chain_id}", cfg.exchange));
        }
        let mc_present = match cfg.multicall {
            MulticallMode::Off => false,
            MulticallMode::Auto | MulticallMode::On => {
                let present = !provider.get_code_at(cfg.multicall_address).await.context("eth_getCode(multicall)")?.is_empty();
                if !present && cfg.multicall == MulticallMode::On {
                    bail!("multicall=on but no contract at {} on chain {chain_id}", cfg.multicall_address);
                }
                present
            }
        };
        info!(
            multicall = mc_present,
            multicall_address = %cfg.multicall_address,
            endpoints = cfg.rpc_urls.len(),
            "read batching: {}",
            if mc_present { "Multicall3 aggregate3" } else { "parallel eth_calls (no Multicall3)" }
        );
        let batch_cfg = BatchCfg { multicall: mc_present.then_some(cfg.multicall_address), chunk: cfg.multicall_chunk, concurrency: cfg.rpc_concurrency };
        let private = match &cfg.send_raw_via {
            Some(u) => {
                let url = u.parse::<alloy::transports::http::reqwest::Url>().map_err(|e| anyhow!("invalid send_raw_via: {e}"))?;
                Some(ProviderBuilder::new().connect_http(url).erased())
            }
            None => None,
        };
        let probes = if urls.len() > 1 { urls.iter().map(|u| RpcClient::new_http(u.clone())).collect() } else { vec![] };
        Ok(Chain {
            caller: Arc::new(CallClient { provider: provider.clone() }),
            provider,
            exchange: cfg.exchange,
            from,
            can_send,
            wallet,
            private,
            nonce: Mutex::new(NonceTracker::default()),
            tx_timeout: Duration::from_secs(cfg.tx_timeout_secs),
            max_attempts: cfg.max_bump_attempts.max(1),
            bump_pct: cfg.gas_bump_pct,
            buffer_pct: cfg.gas_buffer_pct,
            max_fee_wei: gwei_to_wei(cfg.max_fee_gwei),
            chain_id,
            selector,
            probes,
            batch_cfg,
            market_cache: StdMutex::new(HashMap::new()),
        })
    }

    pub fn chain_id(&self) -> u64 { self.chain_id }
    pub fn can_send(&self) -> bool { self.can_send }
    pub fn multicall_enabled(&self) -> bool { self.batch_cfg.multicall.is_some() }
    pub fn private_relay_enabled(&self) -> bool { self.private.is_some() }
    pub fn active_endpoint(&self) -> usize { self.selector.lock().expect("selector").active() }

    fn ex(&self) -> IPerp::IPerpInstance<&DynProvider> {
        IPerp::new(self.exchange, &self.provider)
    }

    /// Probe every endpoint's head (health check), feed the selector (demote dead/lagging, fail back to the preferred one).
    /// Returns the active endpoint index. No-op with a single endpoint.
    pub async fn health_check(&self) -> usize {
        if self.probes.len() < 2 {
            return 0;
        }
        let mut set = tokio::task::JoinSet::new();
        for (i, c) in self.probes.iter().enumerate() {
            let c = c.clone();
            set.spawn(async move {
                let r = tokio::time::timeout(Duration::from_secs(3), c.request_noparams::<U64>("eth_blockNumber")).await;
                (i, r.ok().and_then(|r| r.ok()).map(|n| n.to::<u64>()))
            });
        }
        let mut heads = vec![None; self.probes.len()];
        while let Some(Ok((i, h))) = set.join_next().await {
            heads[i] = h;
        }
        let mut s = self.selector.lock().expect("selector");
        let before = s.active();
        let now = s.update_heads(&heads, Instant::now());
        if now != before {
            info!(from = before, to = now, ?heads, "rpc health check changed the active endpoint");
        }
        now
    }

    pub async fn head(&self) -> Result<HeadInfo> {
        let b = self
            .provider
            .get_block_by_number(BlockNumberOrTag::Latest)
            .await
            .context("eth_getBlockByNumber(latest)")?
            .ok_or_else(|| anyhow!("no latest block"))?;
        Ok(HeadInfo { number: b.header.number, timestamp: b.header.timestamp })
    }

    pub async fn balance(&self) -> Result<U256> {
        Ok(self.provider.get_balance(self.from).await?)
    }

    pub async fn logs(&self, from: u64, to: u64) -> Result<Vec<Log>> {
        let f = Filter::new().address(self.exchange).from_block(from).to_block(to);
        self.provider.get_logs(&f).await.with_context(|| format!("eth_getLogs {from}..={to}"))
    }

    // ------------------------------------------------------------------ views
    pub async fn market_count(&self) -> Result<u8> {
        self.ex().marketCount().call().await.map_err(|e| anyhow!("marketCount: {e}"))
    }

    pub async fn backstop(&self) -> Result<B256> {
        self.ex().BACKSTOP().call().await.map_err(|e| anyhow!("BACKSTOP: {e}"))
    }

    /// Mark price; `Revert(OracleDegraded)` means the oracle is stale/unreadable: callers must wait.
    pub async fn mark_price(&self, m: u8) -> Result<U256, CallErr> {
        self.ex().markPrice(m).call().await.map_err(from_contract)
    }

    pub async fn account_state(&self, a: B256) -> Result<IPerp::accountStateReturn, CallErr> {
        self.ex().accountState(a).call().await.map_err(from_contract)
    }

    pub async fn iso_state(&self, a: B256, m: u8) -> Result<IPerp::isoStateReturn, CallErr> {
        self.ex().isoState(a, m).call().await.map_err(from_contract)
    }

    pub async fn position(&self, a: B256, m: u8) -> Result<IPerp::positionsReturn, CallErr> {
        self.ex().positions(a, m).call().await.map_err(from_contract)
    }

    pub async fn twap_status(&self, id: u64) -> Result<IPerp::Twap, CallErr> {
        self.ex().twapStatus(id).call().await.map_err(from_contract)
    }

    pub async fn adl_debt(&self, m: u8) -> Result<U256, CallErr> {
        self.ex().adlDebt(m).call().await.map_err(from_contract)
    }

    pub async fn adl_health(&self, a: B256, m: u8) -> Result<IPerp::adlHealthReturn, CallErr> {
        self.ex().adlHealth(a, m).call().await.map_err(from_contract)
    }
    pub async fn backstop_cfg(&self, m: u8) -> Result<IPerp::backstopCfgReturn, CallErr> {
        self.ex().backstopCfg(m).call().await.map_err(from_contract)
    }
    pub async fn backstop_equity(&self) -> Result<I256, CallErr> {
        self.ex().backstopEquity().call().await.map_err(from_contract)
    }
    pub async fn bs_ins_drawn(&self) -> Result<U256, CallErr> {
        self.ex().bsInsDrawn().call().await.map_err(from_contract)
    }
    pub async fn bs_debt(&self) -> Result<U256, CallErr> {
        self.ex().bsDebt().call().await.map_err(from_contract)
    }
    pub async fn unresolved_bad_debt(&self) -> Result<U256, CallErr> {
        self.ex().unresolvedBadDebt().call().await.map_err(from_contract)
    }

    pub async fn adl_score(&self, a: B256, m: u8) -> Result<U256, CallErr> {
        self.ex().adlScore(a, m).call().await.map_err(from_contract)
    }

    // ------------------------------------------------------------------ batched views
    fn ex_call(&self, data: Vec<u8>) -> (Address, Bytes) { (self.exchange, Bytes::from(data)) }

    /// Raw batched `eth_call`s (Multicall3 when available, otherwise bounded-parallel single calls).
    pub async fn batch(&self, calls: Vec<(Address, Bytes)>) -> Vec<Result<Bytes, CallErr>> {
        batch_call(&self.caller, &self.batch_cfg, calls).await
    }

    pub async fn read_positions(&self, reqs: &[(B256, u8)]) -> Vec<Result<IPerp::positionsReturn, CallErr>> {
        let calls = reqs.iter().map(|(a, m)| self.ex_call(IPerp::positionsCall { a: *a, market: *m }.abi_encode())).collect();
        self.batch(calls).await.into_iter().map(decode::<IPerp::positionsCall>).collect()
    }

    pub async fn read_account_states(&self, accts: &[B256]) -> Vec<Result<IPerp::accountStateReturn, CallErr>> {
        let calls = accts.iter().map(|a| self.ex_call(IPerp::accountStateCall { a: *a }.abi_encode())).collect();
        self.batch(calls).await.into_iter().map(decode::<IPerp::accountStateCall>).collect()
    }

    pub async fn read_iso_states(&self, reqs: &[(B256, u8)]) -> Vec<Result<IPerp::isoStateReturn, CallErr>> {
        let calls = reqs.iter().map(|(a, m)| self.ex_call(IPerp::isoStateCall { a: *a, market: *m }.abi_encode())).collect();
        self.batch(calls).await.into_iter().map(decode::<IPerp::isoStateCall>).collect()
    }

    /// `liqFeeBps`, `keeperShareBps`, `closeFactorBps`, `fullCloseNotional` (public getters on the exchange).
    pub async fn liq_params(&self) -> Result<LiqParams, CallErr> {
        let calls = vec![
            self.ex_call(IPerp::liqFeeBpsCall {}.abi_encode()),
            self.ex_call(IPerp::keeperShareBpsCall {}.abi_encode()),
            self.ex_call(IPerp::closeFactorBpsCall {}.abi_encode()),
            self.ex_call(IPerp::fullCloseNotionalCall {}.abi_encode()),
        ];
        let mut r = self.batch(calls).await.into_iter();
        let mut next = || r.next().unwrap_or_else(|| Err(CallErr::Transport("missing batch result".into())));
        Ok(LiqParams {
            liq_fee_bps: decode::<IPerp::liqFeeBpsCall>(next())?,
            keeper_share_bps: decode::<IPerp::keeperShareBpsCall>(next())?,
            close_factor_bps: decode::<IPerp::closeFactorBpsCall>(next())?,
            full_close_notional: decode::<IPerp::fullCloseNotionalCall>(next())?,
        })
    }

    /// `lot` and `fundingInterval` of market `m` (cached for 60 s; both are admin parameters).
    pub async fn market_info(&self, m: u8) -> Result<MarketInfo, CallErr> {
        if let Some((t, i)) = self.market_cache.lock().expect("cache").get(&m) {
            if t.elapsed() < Duration::from_secs(60) {
                return Ok(*i);
            }
        }
        let raw = self.caller.raw_call(self.exchange, Bytes::from(IPerp::getMarketCall { m }.abi_encode())).await?;
        let info = parse_market_info(&raw).ok_or_else(|| CallErr::Transport("getMarket: unexpected return layout (ABI drift? see README)".into()))?;
        self.market_cache.lock().expect("cache").insert(m, (Instant::now(), info));
        Ok(info)
    }

    // ------------------------------------------------------------------ simulation + sending
    fn request(&self, data: Bytes) -> TransactionRequest {
        self.request_at(self.exchange, U256::ZERO, data)
    }

    fn request_at(&self, to: Address, value: U256, data: Bytes) -> TransactionRequest {
        let r = TransactionRequest::default().with_from(self.from).with_to(to).with_input(data);
        if value.is_zero() { r } else { r.with_value(value) }
    }

    /// Current max-fee-per-gas bid (wei) without any estimate.
    pub async fn gas_price_wei(&self) -> Result<u128, CallErr> {
        self.fee_params().await.map(|(f, _)| f).map_err(|e| CallErr::Transport(e.to_string()))
    }

    /// True when a signing key is loaded (dry-run without a key has none; its `from` is a placeholder with no balance).
    pub fn has_signer(&self) -> bool { self.wallet.is_some() }

    /// Plain `eth_call` view against an arbitrary contract (latest block, no `from`).
    pub async fn view_at(&self, to: Address, data: Bytes) -> Result<Bytes, CallErr> {
        self.caller.raw_call(to, data).await
    }

    /// eth_call as the keeper against an arbitrary contract with a `value` (used for payable calls such as Pyth `updatePriceFeeds`).
    pub async fn simulate_at(&self, to: Address, value: U256, data: &Bytes) -> Result<(), CallErr> {
        self.provider.call(self.request_at(to, value, data.clone())).await.map(|_| ()).map_err(|e| from_transport(&e))
    }

    /// `(gas estimate, gas limit that would be used, first-attempt max fee per gas, worst-case fee per gas after all bumps)` in wei.
    /// The worst case honours `max_fee_gwei`; if even the first bid exceeds the cap this is an error (the send would refuse too).
    pub async fn quote_at(&self, to: Address, value: U256, data: &Bytes) -> Result<(u64, u64, u128, u128), CallErr> {
        let gas = self.provider.estimate_gas(self.request_at(to, value, data.clone())).await.map_err(|e| from_transport(&e))?;
        let (max_fee, _) = self.fee_params().await.map_err(|e| CallErr::Transport(e.to_string()))?;
        let worst = fee_for_attempt(max_fee, self.bump_pct, self.max_attempts.saturating_sub(1), self.max_fee_wei)
            .ok_or_else(|| CallErr::Transport(format!("fee {max_fee} wei is above the max_fee_gwei cap")))?;
        Ok((gas, gas_with_buffer(gas, self.buffer_pct), max_fee, worst))
    }

    /// eth_call the exact calldata as the keeper. Ok(()) means it would succeed on the current state.
    pub async fn simulate(&self, data: &Bytes) -> Result<(), CallErr> {
        self.provider.call(self.request(data.clone())).await.map(|_| ()).map_err(|e| from_transport(&e))
    }

    async fn fee_params(&self) -> Result<(u128, u128)> {
        match self.provider.estimate_eip1559_fees().await {
            Ok(e) => Ok((e.max_fee_per_gas, e.max_priority_fee_per_gas)),
            Err(_) => {
                let gp = self.provider.get_gas_price().await.context("eth_gasPrice")?;
                Ok((gp, gp.min(1_500_000_000)))
            }
        }
    }

    /// `(gas estimate, max fee per gas in wei)` for sending `data` now (conservative: uses the max-fee bid).
    pub async fn estimate_cost(&self, data: &Bytes) -> Result<(u64, u128), CallErr> {
        let gas = self.provider.estimate_gas(self.request(data.clone())).await.map_err(|e| from_transport(&e))?;
        let (max_fee, _) = self.fee_params().await.map_err(|e| CallErr::Transport(e.to_string()))?;
        Ok((gas, max_fee))
    }

    /// Sign locally and broadcast: through the public provider, or (if configured) as a raw tx to the private endpoint.
    async fn send(&self, req: TransactionRequest) -> Result<B256, TransportError> {
        match (&self.private, &self.wallet) {
            (Some(p), Some(w)) => {
                let env = req.build(w).await.map_err(|e| TransportErrorKind::custom_str(&format!("signing: {e}")))?;
                let raw = env.encoded_2718();
                let pending = p.send_raw_transaction(&raw).await?;
                Ok(*pending.tx_hash())
            }
            _ => Ok(*self.provider.send_transaction(req).await?.tx_hash()),
        }
    }

    /// Simulate + estimate + sign + send + wait, replacing the transaction with higher fees if it is not mined in time.
    /// Transactions are serialised (one nonce lane) by holding the nonce lock for the whole lifecycle.
    pub async fn execute(&self, label: &str, data: Bytes) -> Result<Sent, SendError> {
        self.execute_at(label, self.exchange, U256::ZERO, data).await
    }

    /// Same as `execute` for an arbitrary target contract and `value` (the Pyth pusher).
    pub async fn execute_at(&self, label: &str, to: Address, value: U256, data: Bytes) -> Result<Sent, SendError> {
        if !self.can_send {
            return Err(SendError::NoSigner);
        }
        // 1) gas estimate doubles as a final simulation against pending state
        let gas = match self.provider.estimate_gas(self.request_at(to, value, data.clone())).await {
            Ok(g) => g,
            Err(e) => {
                return Err(match from_transport(&e) {
                    CallErr::Revert(k) => SendError::Reverted(k),
                    CallErr::Transport(s) => SendError::Rpc(s),
                })
            }
        };
        let gas_limit = gas_with_buffer(gas, self.buffer_pct);
        let (base_fee, base_tip) = self.fee_params().await.map_err(|e| SendError::Rpc(e.to_string()))?;

        let mut nonce_guard = self.nonce.lock().await;
        let mut resyncs = 0u32;
        'outer: loop {
            if nonce_guard.peek().is_none() {
                let n = self.provider.get_transaction_count(self.from).pending().await.map_err(|e| SendError::Rpc(e.to_string()))?;
                nonce_guard.set_from_chain(n);
            }
            let nonce = nonce_guard.peek().expect("set above");
            let mut hashes: Vec<B256> = vec![];

            for attempt in 0..self.max_attempts {
                let Some(max_fee) = fee_for_attempt(base_fee, self.bump_pct, attempt, self.max_fee_wei) else {
                    nonce_guard.resync();
                    return Err(SendError::FeeCap);
                };
                let tip = bump_to(base_tip, self.bump_pct, attempt).min(max_fee);
                let req = self
                    .request_at(to, value, data.clone())
                    .with_nonce(nonce)
                    .with_gas_limit(gas_limit)
                    .with_chain_id(self.chain_id)
                    .with_max_fee_per_gas(max_fee)
                    .with_max_priority_fee_per_gas(tip);
                match self.send(req).await {
                    Ok(h) => {
                        debug!(%label, nonce, attempt, %h, max_fee, private = self.private.is_some(), "tx sent");
                        hashes.push(h);
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        match send_error_action(&msg, !hashes.is_empty(), resyncs) {
                            // a replacement can race with the original being mined ("nonce too low"): check receipts below
                            SendAction::CheckReceipts => debug!(%label, nonce, "nonce error on replacement; checking earlier hashes"),
                            SendAction::ResyncAndRetry => {
                                warn!(%label, nonce, error = %msg, "nonce out of sync: re-reading the node's pending nonce and retrying once");
                                nonce_guard.resync();
                                resyncs += 1;
                                continue 'outer;
                            }
                            SendAction::ResyncAndFail => {
                                nonce_guard.resync();
                                return Err(SendError::Rpc(msg));
                            }
                            SendAction::Fail => {
                                return Err(match from_transport(&e) {
                                    CallErr::Revert(k) => SendError::Reverted(k),
                                    CallErr::Transport(_) => SendError::Rpc(msg),
                                })
                            }
                        }
                    }
                }
                if let Some((h, rcpt_ok, gas_used, block, egp)) = self.wait_any(&hashes).await {
                    nonce_guard.consume();
                    return if rcpt_ok {
                        Ok(Sent { hash: h, gas_used, block, attempts: attempt + 1, effective_gas_price: egp })
                    } else {
                        Err(SendError::MinedRevert(h))
                    };
                }
                warn!(%label, nonce, attempt, "tx not mined within timeout; bumping fee");
            }
            // Unknown outcome: forget the cached nonce; the next send re-reads the node's pending count.
            nonce_guard.resync();
            return Err(SendError::Timeout(self.max_attempts, hashes));
        }
    }

    /// Poll receipts of any of `hashes` until the timeout. Returns (hash, success, gas_used, block, effective gas price).
    async fn wait_any(&self, hashes: &[B256]) -> Option<(B256, bool, u64, u64, u128)> {
        let deadline = tokio::time::Instant::now() + self.tx_timeout;
        loop {
            for h in hashes {
                if let Ok(Some(r)) = self.provider.get_transaction_receipt(*h).await {
                    return Some((*h, r.status(), r.gas_used, r.block_number.unwrap_or_default(), r.effective_gas_price));
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

impl ScanSource for Chain {
    async fn header(&self, n: u64) -> Result<Option<(B256, B256)>> {
        let b = self.provider.get_block_by_number(BlockNumberOrTag::Number(n)).await.with_context(|| format!("eth_getBlockByNumber({n})"))?;
        Ok(b.map(|b| (b.header.hash, b.header.parent_hash)))
    }

    async fn logs(&self, from: u64, to: u64) -> Result<Vec<Log>> {
        Chain::logs(self, from, to).await
    }
}

fn bump_to(base: u128, pct: u64, attempt: u32) -> u128 {
    let mut f = base;
    for _ in 0..attempt {
        f = bump_fee(f, pct);
    }
    f
}

/// Convenience used in logs.
pub fn log_signer(addr: Address, chain_id: u64, dry_run: bool) {
    info!(keeper = %addr, chain_id, dry_run, "keeper identity (permissionless: no on-chain roles)");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(n: u64) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[24..].copy_from_slice(&n.to_be_bytes());
        b
    }

    #[test]
    fn parses_market_info_from_abi_layout() {
        let mut data = vec![];
        data.extend_from_slice(&w(32)); // offset to the tuple
        for i in 0..20u64 {
            data.extend_from_slice(&w(match i as usize {
                MARKET_LOT_WORD => 100_000,
                MARKET_FUNDING_INTERVAL_WORD => 3600,
                _ => 7,
            }));
        }
        assert_eq!(parse_market_info(&data), Some(MarketInfo { lot: 100_000, funding_interval: 3600 }));
        assert_eq!(parse_market_info(&data[..100]), None); // truncated
        assert_eq!(parse_market_info(&[]), None);
        let mut bad = data.clone();
        bad[..32].copy_from_slice(&w(33)); // misaligned offset
        assert_eq!(parse_market_info(&bad), None);
    }
}
