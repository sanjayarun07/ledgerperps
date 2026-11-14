//! Feature 9: Pyth price pusher (opt-in, `enable_pyth_push`, default OFF).
//!
//! Pyth is a PULL oracle: a price exists on-chain only after somebody submits a signed update. `MedianOracle` rejects a source older
//! than its `maxAge`, so without a pusher every price read reverts `OracleDegraded` and the keeper (and the exchange) wait forever.
//!
//! Loop (every `pyth_push_interval_secs`, +/- jitter):
//!   1. read `getPriceUnsafe(feed).publishTime` for every configured feed (cheap views) and publish the age as a metric;
//!   2. if no feed is at least `pyth_push_when_age_secs` old (default maxAge/2), stop. Hermes is not contacted;
//!   3. fetch signed updates from Hermes (`/v2/updates/price/latest`); if Hermes reports nothing newer than what is on-chain
//!      for any due feed (market closed / feed paused), stop: pushing would only burn the fee;
//!   4. `getUpdateFee(bytes[])` must be <= `pyth_max_fee_wei`; `updatePriceFeeds` is `eth_call`-simulated with `value = fee`;
//!   5. gas gate: estimated gas cost must be <= `pyth_max_gas_usd` (`--force-unprofitable` overrides THIS gate only);
//!   6. hourly budget: fee + worst-case gas of this push plus everything spent in the last hour must be <= `pyth_hourly_budget_wei`
//!      (a hard limit; nothing overrides it). Timed-out sends are booked at their worst case because they may still be mined;
//!   7. dry-run (or no signer) stops here and counts `keeper_pyth_push_total{result="dry_run"}`; otherwise sign with the keeper wallet and send.
//!
//! Failures never panic and never stall the other features. Hermes errors back off exponentially with jitter: 401/403 start at 60 s
//! (credentials will not fix themselves; see the README on API keys), 429 honours `Retry-After`, 5xx/network start at 5 s. All state
//! needed to enforce the budget survives a restart (it lives in the keeper checkpoint).
use crate::{
    abi::IPyth,
    actions::{fmt_micro, Ctx},
    chain::{CallErr, Chain, SendError, Sent},
    config::{PythCfg, SecretUrl},
    errors::RevertKind,
    metrics::{unix_now, FeedLabel, Metrics},
    profit::{decide, gas_cost_micro_usd, usd_to_micro, Decision},
};
use alloy::{
    primitives::{Address, Bytes, B256, U256},
    sol_types::SolCall,
    transports::http::reqwest::{
        self,
        header::{HeaderName, HeaderValue},
        StatusCode, Url,
    },
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, time::Duration};
use tracing::{debug, error, info, warn};

/// Window of the spend budget.
pub const BUDGET_WINDOW_SECS: u64 = 3600;
/// Gas assumed for the gate when the node cannot estimate (dry-run without a funded signer). Conservative for a few-feed push.
pub const ASSUMED_GAS: u64 = 400_000;
const BACKOFF_BASE_SECS: u64 = 5;
const BACKOFF_CAP_SECS: u64 = 300;
const AUTH_BACKOFF_BASE_SECS: u64 = 60;
const AUTH_BACKOFF_CAP_SECS: u64 = 900;
const RATE_LIMIT_CAP_SECS: u64 = 3600;

// ------------------------------------------------------------------------------------------------------------------ persisted state

/// Pusher bookkeeping stored in the keeper checkpoint (`State.pyth`). Wall-clock (unix) seconds throughout.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct PythPersist {
    /// Do nothing before this time (regular schedule, or the end of a backoff).
    pub next_run_unix: u64,
    pub consecutive_failures: u32,
    /// `(unix time, wei)` of money spent or reserved; entries older than the budget window are pruned.
    pub ledger: Vec<(u64, u64)>,
    pub last_push_unix: u64,
    pub pushes: u64,
    pub total_spent_wei: u64,
}

impl PythPersist {
    pub fn prune(&mut self, now: u64) {
        self.ledger.retain(|(t, _)| now.saturating_sub(*t) < BUDGET_WINDOW_SECS);
    }
    pub fn spent_in_window(&self, now: u64) -> u64 {
        self.ledger.iter().filter(|(t, _)| now.saturating_sub(*t) < BUDGET_WINDOW_SECS).fold(0u64, |a, (_, w)| a.saturating_add(*w))
    }
    pub fn record(&mut self, now: u64, wei: u64) {
        self.ledger.push((now, wei));
        self.total_spent_wei = self.total_spent_wei.saturating_add(wei);
    }
}

// ------------------------------------------------------------------------------------------------------------------ pure planning

/// What the chain says about one feed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedStatus {
    /// `publishTime` of the stored price.
    Published(u64),
    /// `getPriceUnsafe` reverted: the contract has never seen this feed (or the id is wrong). Needs a push.
    Missing,
    /// Transport problem: unknown. The tick is retried later and nothing is decided.
    Unreadable,
}

impl FeedStatus {
    /// Age in seconds at `now` (a publishTime in the future counts as age 0). `None` for Missing/Unreadable.
    pub fn age(&self, now: u64) -> Option<u64> {
        match self {
            FeedStatus::Published(t) => Some(now.saturating_sub(*t)),
            _ => None,
        }
    }
}

/// True when at least one feed needs an update: published but at least `push_when` old, or never published.
pub fn any_due(statuses: &[FeedStatus], now: u64, push_when: u64) -> bool {
    statuses.iter().any(|s| match s {
        FeedStatus::Published(_) => s.age(now).is_some_and(|a| a >= push_when),
        FeedStatus::Missing => true,
        FeedStatus::Unreadable => false,
    })
}

/// True when Hermes can improve at least one due feed. A feed Hermes did not report (or a response without `parsed`) is treated as
/// "maybe newer": we only refuse when Hermes positively reports no newer `publish_time` for EVERY due feed.
pub fn hermes_has_newer(feeds: &[B256], statuses: &[FeedStatus], now: u64, push_when: u64, hermes_times: &HashMap<B256, u64>) -> bool {
    feeds.iter().zip(statuses).any(|(id, st)| {
        let due = match st {
            FeedStatus::Published(_) => st.age(now).is_some_and(|a| a >= push_when),
            FeedStatus::Missing => true,
            FeedStatus::Unreadable => false,
        };
        if !due {
            return false;
        }
        match (st, hermes_times.get(id)) {
            (FeedStatus::Published(chain_t), Some(h)) => h > chain_t,
            _ => true,
        }
    })
}

/// Why a Hermes request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HermesError {
    /// 401/403: missing, wrong or expired credentials, or the endpoint requires a key.
    Unauthorized(u16),
    RateLimited { retry_after_secs: Option<u64> },
    Server(u16),
    /// Other 4xx (bad ids, unsupported parameters).
    Client(u16),
    /// Connect/DNS/TLS/timeout.
    Network(String),
    /// 2xx but not the expected JSON.
    BadBody(String),
}

impl HermesError {
    pub fn kind(&self) -> &'static str {
        match self {
            HermesError::Unauthorized(_) => "unauthorized",
            HermesError::RateLimited { .. } => "rate_limited",
            HermesError::Server(_) => "server",
            HermesError::Client(_) => "client",
            HermesError::Network(_) => "network",
            HermesError::BadBody(_) => "bad_body",
        }
    }
}

impl std::fmt::Display for HermesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HermesError::Unauthorized(c) => write!(f, "HTTP {c}"),
            HermesError::RateLimited { retry_after_secs: Some(s) } => write!(f, "HTTP 429 (Retry-After {s}s)"),
            HermesError::RateLimited { retry_after_secs: None } => write!(f, "HTTP 429"),
            HermesError::Server(c) | HermesError::Client(c) => write!(f, "HTTP {c}"),
            HermesError::Network(m) => write!(f, "network error: {m}"),
            HermesError::BadBody(m) => write!(f, "unexpected response: {m}"),
        }
    }
}

/// Seconds to wait after the `n`-th consecutive failure (`n >= 1`), before jitter.
pub fn backoff_secs(err: &HermesError, n: u32) -> u64 {
    let exp = |base: u64, cap: u64| base.saturating_mul(1u64 << n.saturating_sub(1).min(20)).min(cap);
    match err {
        HermesError::Unauthorized(_) | HermesError::Client(_) => exp(AUTH_BACKOFF_BASE_SECS, AUTH_BACKOFF_CAP_SECS),
        HermesError::RateLimited { retry_after_secs } => exp(BACKOFF_BASE_SECS * 2, BACKOFF_CAP_SECS).max(retry_after_secs.unwrap_or(0)).min(RATE_LIMIT_CAP_SECS),
        HermesError::Server(_) | HermesError::Network(_) | HermesError::BadBody(_) => exp(BACKOFF_BASE_SECS, BACKOFF_CAP_SECS),
    }
}

/// Backoff for failures that are not Hermes' (simulation reverts, RPC errors, failed sends).
pub fn generic_backoff_secs(n: u32) -> u64 {
    BACKOFF_BASE_SECS.saturating_mul(1u64 << n.saturating_sub(1).min(20)).min(BACKOFF_CAP_SECS)
}

/// `secs` +/- `pct` percent, picked by `rand` (any u64). Result is at least 1.
pub fn jittered(secs: u64, pct: u64, rand: u64) -> u64 {
    if pct == 0 || secs == 0 {
        return secs.max(1);
    }
    let span = secs.saturating_mul(pct) / 100; // max deviation
    if span == 0 {
        return secs.max(1);
    }
    let off = rand % (2 * span + 1); // 0..=2*span
    (secs - span + off).max(1)
}

/// Spend admission: `projected` must fit under the budget together with what was spent in the window. Hard limit.
pub fn within_budget(spent_in_window: u64, projected: u64, budget: u64) -> bool {
    spent_in_window.checked_add(projected).is_some_and(|t| t <= budget)
}

// ------------------------------------------------------------------------------------------------------------------ Hermes client

/// Signed updates plus Hermes' own view of the publish times.
#[derive(Debug, Clone, Default)]
pub struct HermesUpdate {
    /// `updateData` blobs for `updatePriceFeeds`.
    pub blobs: Vec<Bytes>,
    /// Latest `publish_time` Hermes reports per feed id (empty when the response had no `parsed` section).
    pub publish_times: HashMap<B256, u64>,
    /// `(price, conf, expo)` as Hermes reports them (only when the response had `parsed`).
    pub prices: HashMap<B256, (i64, u64, i32)>,
}

pub trait Hermes: Send + Sync {
    fn latest(&self, ids: &[B256]) -> impl Future<Output = Result<HermesUpdate, HermesError>> + Send;
}

#[derive(Deserialize)]
struct HResp {
    binary: HBinary,
    #[serde(default)]
    parsed: Vec<HParsed>,
}
#[derive(Deserialize)]
struct HBinary {
    data: Vec<String>,
}
#[derive(Deserialize)]
struct HParsed {
    id: String,
    price: HPrice,
}
#[derive(Deserialize)]
struct HPrice {
    publish_time: i64,
    /// Integer string in the real API (`"6500000000000"`); a bare integer is accepted too.
    #[serde(default)]
    price: Option<serde_json::Value>,
    #[serde(default)]
    conf: Option<serde_json::Value>,
    #[serde(default)]
    expo: Option<i32>,
}

fn int_of(v: &Option<serde_json::Value>) -> Option<i64> {
    match v.as_ref()? {
        serde_json::Value::String(s) => s.parse().ok(),
        serde_json::Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// Parse a Hermes `/v2/updates/price/latest` body.
pub fn parse_hermes_body(body: &[u8]) -> Result<HermesUpdate, HermesError> {
    let r: HResp = serde_json::from_slice(body).map_err(|e| HermesError::BadBody(format!("json: {e}")))?;
    if r.binary.data.is_empty() {
        return Err(HermesError::BadBody("no update blobs".into()));
    }
    let mut blobs = vec![];
    for h in &r.binary.data {
        let b = alloy::hex::decode(h.trim_start_matches("0x")).map_err(|e| HermesError::BadBody(format!("blob is not hex: {e}")))?;
        if b.is_empty() {
            return Err(HermesError::BadBody("empty update blob".into()));
        }
        blobs.push(Bytes::from(b));
    }
    let mut publish_times = HashMap::new();
    let mut prices = HashMap::new();
    for p in r.parsed {
        if let (Ok(id), true) = (format!("0x{}", p.id.trim_start_matches("0x")).parse::<B256>(), p.price.publish_time >= 0) {
            publish_times.insert(id, p.price.publish_time as u64);
            if let (Some(px), Some(expo)) = (int_of(&p.price.price), p.price.expo) {
                prices.insert(id, (px, int_of(&p.price.conf).unwrap_or(0).max(0) as u64, expo));
            }
        }
    }
    Ok(HermesUpdate { blobs, publish_times, prices })
}

/// Map an HTTP status (+ `Retry-After` header value) to the error it means; `None` for success.
pub fn classify_status(status: u16, retry_after: Option<&str>) -> Option<HermesError> {
    match status {
        200..=299 => None,
        401 | 403 => Some(HermesError::Unauthorized(status)),
        429 => Some(HermesError::RateLimited { retry_after_secs: retry_after.and_then(|v| v.trim().parse::<u64>().ok()) }),
        500..=599 => Some(HermesError::Server(status)),
        _ => Some(HermesError::Client(status)),
    }
}

/// Real HTTP client. The API key (if any) lives only in a sensitive `HeaderValue`; `Debug` shows neither it nor the full URL.
pub struct HermesClient {
    http: reqwest::Client,
    base: Url,
    shown: String,
    header: Option<(HeaderName, HeaderValue)>,
}

impl std::fmt::Debug for HermesClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HermesClient").field("endpoint", &self.shown).field("auth_header", &self.header.as_ref().map(|(n, _)| n.as_str())).finish()
    }
}

impl HermesClient {
    pub fn new(cfg: &PythCfg) -> anyhow::Result<HermesClient> {
        let from_env = |n: &str| std::env::var(n).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let key = from_env(&cfg.api_key_env).or_else(|| from_env(crate::config::FALLBACK_HERMES_KEY_ENV));
        Self::build(&cfg.hermes_url, &cfg.api_key_header, &cfg.api_key_prefix, key.as_deref(), Duration::from_secs(cfg.hermes_timeout_secs))
    }

    pub fn build(url: &SecretUrl, header_name: &str, prefix: &str, key: Option<&str>, timeout: Duration) -> anyhow::Result<HermesClient> {
        let base = url.expose().parse::<Url>().map_err(|_| anyhow::anyhow!("hermes_url is not a valid URL"))?;
        let header = match key {
            Some(v) => {
                let name = header_name.parse::<HeaderName>().map_err(|e| anyhow::anyhow!("invalid hermes_api_key_header: {e}"))?;
                // do not echo `v`: only say it is malformed
                let mut val = HeaderValue::from_str(&format!("{prefix}{v}")).map_err(|_| anyhow::anyhow!("the Hermes API key env var holds a value that is not a valid HTTP header value"))?;
                val.set_sensitive(true);
                Some((name, val))
            }
            None => None,
        };
        let http = reqwest::Client::builder().timeout(timeout).user_agent("perp-keeper").build().map_err(|e| anyhow::anyhow!("building HTTP client: {}", e.without_url()))?;
        Ok(HermesClient { http, base, shown: url.redacted(), header })
    }

    pub fn endpoint(&self) -> &str { &self.shown }
    pub fn has_auth(&self) -> bool { self.header.is_some() }

    fn request_url(&self, ids: &[B256]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut segs) = url.path_segments_mut() {
            segs.pop_if_empty().extend(["v2", "updates", "price", "latest"]);
        }
        {
            let mut q = url.query_pairs_mut();
            for id in ids {
                q.append_pair("ids[]", &format!("{id:#x}")[2..]);
            }
            q.append_pair("encoding", "hex");
            q.append_pair("parsed", "true");
        }
        url
    }
}

impl Hermes for HermesClient {
    async fn latest(&self, ids: &[B256]) -> Result<HermesUpdate, HermesError> {
        let mut req = self.http.get(self.request_url(ids));
        if let Some((n, v)) = &self.header {
            req = req.header(n.clone(), v.clone());
        }
        let resp = req.send().await.map_err(|e| HermesError::Network(e.without_url().to_string()))?;
        let status: StatusCode = resp.status();
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_string);
        if let Some(e) = classify_status(status.as_u16(), retry_after.as_deref()) {
            return Err(e);
        }
        let body = resp.bytes().await.map_err(|e| HermesError::Network(e.without_url().to_string()))?;
        parse_hermes_body(&body)
    }
}

// ------------------------------------------------------------------------------------------------------------------ chain side

pub enum Sim {
    Passed,
    /// Not simulated, with the reason (dry-run without a signer: an unfunded placeholder sender cannot attach `value`).
    Skipped(&'static str),
}

/// Gas numbers for the gate and for the budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quote {
    pub gas: u64,
    pub gas_limit: u64,
    /// First-attempt max fee per gas (wei): the price the gas gate uses, like every other feature.
    pub max_fee_per_gas: u128,
    /// Max fee per gas after every replacement bump (bounded by `max_fee_gwei`): what the budget must reserve.
    pub worst_fee_per_gas: u128,
    /// True when the node could not estimate and `ASSUMED_GAS` was used.
    pub assumed: bool,
}

pub trait PythChain: Send + Sync {
    fn publish_time(&self, feed: B256) -> impl Future<Output = Result<u64, CallErr>> + Send;
    fn update_fee(&self, updates: &[Bytes]) -> impl Future<Output = Result<U256, CallErr>> + Send;
    fn simulate(&self, data: &Bytes, value: U256) -> impl Future<Output = Result<Sim, CallErr>> + Send;
    fn quote(&self, data: &Bytes, value: U256) -> impl Future<Output = Result<Quote, CallErr>> + Send;
    fn send(&self, data: Bytes, value: U256) -> impl Future<Output = Result<Sent, SendError>> + Send;
    /// False in dry-run / without a signer.
    fn can_send(&self) -> bool;
}

/// The real chain, aimed at the Pyth contract.
pub struct ChainPyth<'a> {
    pub chain: &'a Chain,
    pub pyth: Address,
}

impl PythChain for ChainPyth<'_> {
    async fn publish_time(&self, feed: B256) -> Result<u64, CallErr> {
        let raw = self.chain.view_at(self.pyth, Bytes::from(IPyth::getPriceUnsafeCall { id: feed }.abi_encode())).await?;
        let p = IPyth::getPriceUnsafeCall::abi_decode_returns(&raw).map_err(|e| CallErr::Transport(format!("decode getPriceUnsafe: {e}")))?;
        Ok(u64::try_from(p.publishTime).unwrap_or(u64::MAX))
    }

    async fn update_fee(&self, updates: &[Bytes]) -> Result<U256, CallErr> {
        let raw = self.chain.view_at(self.pyth, Bytes::from(IPyth::getUpdateFeeCall { updateData: updates.to_vec() }.abi_encode())).await?;
        IPyth::getUpdateFeeCall::abi_decode_returns(&raw).map_err(|e| CallErr::Transport(format!("decode getUpdateFee: {e}")))
    }

    async fn simulate(&self, data: &Bytes, value: U256) -> Result<Sim, CallErr> {
        if !self.chain.has_signer() {
            return Ok(Sim::Skipped("no signing key: the placeholder sender has no balance for the fee"));
        }
        self.chain.simulate_at(self.pyth, value, data).await.map(|_| Sim::Passed)
    }

    async fn quote(&self, data: &Bytes, value: U256) -> Result<Quote, CallErr> {
        match self.chain.quote_at(self.pyth, value, data).await {
            Ok((gas, gas_limit, max_fee_per_gas, worst_fee_per_gas)) => Ok(Quote { gas, gas_limit, max_fee_per_gas, worst_fee_per_gas, assumed: false }),
            // an unsigned dry-run cannot estimate a payable call; price it with a fixed assumption instead of failing
            Err(_) if !self.chain.has_signer() => {
                let fee = self.chain.gas_price_wei().await?;
                Ok(Quote { gas: ASSUMED_GAS, gas_limit: ASSUMED_GAS, max_fee_per_gas: fee, worst_fee_per_gas: fee, assumed: true })
            }
            Err(e) => Err(e),
        }
    }

    async fn send(&self, data: Bytes, value: U256) -> Result<Sent, SendError> {
        self.chain.execute_at("pyth_push", self.pyth, value, data).await
    }

    fn can_send(&self) -> bool { self.chain.can_send() }
}

// ------------------------------------------------------------------------------------------------------------------ orchestration

/// Everything `step` needs besides the I/O clients.
pub struct Env<'a> {
    pub cfg: &'a PythCfg,
    pub metrics: &'a Metrics,
    pub dry_run: bool,
    pub force: bool,
    pub native_usd_micro: u128,
    pub min_profit_micro: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    /// Not yet time.
    Idle,
    /// Every feed is younger than the push threshold (or the chain could not be read).
    Fresh,
    HermesFailed { kind: &'static str, backoff_secs: u64 },
    NoNewerData,
    FeeAboveCap { fee: u64 },
    GasAboveBudget,
    OverHourlyBudget,
    SimFailed { backoff_secs: u64 },
    RpcFailed,
    DryRun { fee: u64 },
    Sent { fee: u64, gas_wei: u64 },
    SendFailed { backoff_secs: u64 },
}

impl StepOutcome {
    pub fn is_sent(&self) -> bool { matches!(self, StepOutcome::Sent { .. }) }
}

fn to_u64(v: U256) -> u64 {
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// One scheduling step. `now_chain` is the head block timestamp (what the oracle's age is measured against), `now_wall` the local
/// clock (schedule, backoff, budget window), `rand` a random word for jitter.
pub async fn step<H: Hermes, C: PythChain>(env: &Env<'_>, st: &mut PythPersist, hermes: &H, chain: &C, now_chain: u64, now_wall: u64, rand: u64) -> StepOutcome {
    let cfg = env.cfg;
    let m = env.metrics;
    st.prune(now_wall);
    m.pyth_budget_spent_wei.set(st.spent_in_window(now_wall).min(i64::MAX as u64) as i64);
    m.pyth_backoff_seconds.set(st.next_run_unix.saturating_sub(now_wall).min(i64::MAX as u64) as i64 * (st.consecutive_failures > 0) as i64);
    if now_wall < st.next_run_unix {
        return StepOutcome::Idle;
    }
    let regular_next = now_wall + jittered(cfg.push_interval_secs, cfg.jitter_pct, rand);
    st.next_run_unix = regular_next;

    // 1) on-chain ages
    let ids: Vec<B256> = cfg.feeds.iter().map(|(_, id)| *id).collect();
    let mut statuses = Vec::with_capacity(ids.len());
    for (label, id) in &cfg.feeds {
        let s = match chain.publish_time(*id).await {
            Ok(t) => FeedStatus::Published(t),
            Err(CallErr::Revert(k)) => {
                warn!(feed = %label, reason = %k.label(), "pyth: getPriceUnsafe reverted: the feed has never been published to this contract (or the id is wrong); will push");
                FeedStatus::Missing
            }
            Err(CallErr::Transport(e)) => {
                debug!(feed = %label, error = %e, "pyth: could not read the on-chain price; retrying next interval");
                FeedStatus::Unreadable
            }
        };
        if let Some(a) = s.age(now_chain) {
            m.pyth_age_seconds.get_or_create(&FeedLabel { feed: label.clone() }).set(a.min(i64::MAX as u64) as i64);
        }
        statuses.push(s);
    }
    if statuses.contains(&FeedStatus::Unreadable) {
        m.inc_pyth("failed_rpc");
        return StepOutcome::RpcFailed;
    }
    if !any_due(&statuses, now_chain, cfg.push_when_age_secs) {
        m.inc_pyth("skipped_fresh");
        // quiet recovery: a healthy check resets the failure counter
        st.consecutive_failures = 0;
        return StepOutcome::Fresh;
    }
    let oldest = statuses.iter().filter_map(|s| s.age(now_chain)).max();
    info!(oldest_age_secs = ?oldest, push_when_age_secs = cfg.push_when_age_secs, max_age_secs = cfg.max_age_secs, "pyth: a feed is due for an update");

    // 2) cheap budget pre-check (before spending Hermes quota)
    let spent = st.spent_in_window(now_wall);
    if spent >= cfg.hourly_budget_wei {
        m.inc_pyth("skipped_budget");
        st.next_run_unix = st.next_run_unix.max(now_wall + 60);
        warn!(spent_wei = spent, budget_wei = cfg.hourly_budget_wei, "pyth: hourly budget exhausted; not pushing (prices will go stale; raise pyth_hourly_budget_wei or investigate the spend)");
        return StepOutcome::OverHourlyBudget;
    }

    // 3) Hermes
    let update = match hermes.latest(&ids).await {
        Ok(u) => u,
        Err(e) => {
            st.consecutive_failures = st.consecutive_failures.saturating_add(1);
            Metrics::inc_kind(&m.pyth_hermes_errors, e.kind());
            m.inc_pyth("failed_hermes");
            let wait = jittered(backoff_secs(&e, st.consecutive_failures), cfg.jitter_pct, rand);
            st.next_run_unix = now_wall + wait;
            m.pyth_backoff_seconds.set(wait as i64);
            match &e {
                HermesError::Unauthorized(_) => error!(
                    failures = st.consecutive_failures, retry_in_secs = wait, endpoint = %cfg.hermes_url.redacted(),
                    "pyth: Hermes rejected the request ({e}). The endpoint needs credentials: set hermes_url to a provider endpoint you can use and/or export the API key in the env var named by hermes_api_key_env (header `{}`, e.g. HERMES_API_KEY). On-chain prices will go stale until this is fixed.", cfg.api_key_header
                ),
                HermesError::RateLimited { .. } => warn!(failures = st.consecutive_failures, retry_in_secs = wait, endpoint = %cfg.hermes_url.redacted(), "pyth: Hermes rate limit ({e}); backing off"),
                _ => warn!(failures = st.consecutive_failures, retry_in_secs = wait, endpoint = %cfg.hermes_url.redacted(), "pyth: Hermes request failed ({e}); backing off"),
            }
            return StepOutcome::HermesFailed { kind: e.kind(), backoff_secs: wait };
        }
    };
    if !hermes_has_newer(&ids, &statuses, now_chain, cfg.push_when_age_secs, &update.publish_times) {
        m.inc_pyth("skipped_no_newer");
        st.consecutive_failures = 0;
        warn!("pyth: Hermes has no newer price than the chain for any due feed (feed paused or market closed?); not paying for a no-op push");
        return StepOutcome::NoNewerData;
    }

    // 4) fee
    let fail = |st: &mut PythPersist, counter: &str| -> u64 {
        st.consecutive_failures = st.consecutive_failures.saturating_add(1);
        m.inc_pyth(counter);
        let wait = jittered(generic_backoff_secs(st.consecutive_failures), cfg.jitter_pct, rand);
        st.next_run_unix = now_wall + wait;
        m.pyth_backoff_seconds.set(wait as i64);
        wait
    };
    let fee = match chain.update_fee(&update.blobs).await {
        Ok(f) => f,
        Err(e) => {
            let wait = fail(st, "failed_fee_quote");
            warn!(error = %e, retry_in_secs = wait, "pyth: getUpdateFee failed (wrong Pyth contract, or Hermes data from a different network/channel than this contract accepts)");
            return StepOutcome::SimFailed { backoff_secs: wait };
        }
    };
    let fee64 = to_u64(fee);
    if fee > U256::from(cfg.max_fee_wei) {
        st.next_run_unix = now_wall + 60;
        m.inc_pyth("skipped_fee_cap");
        error!(fee_wei = %fee, max_fee_wei = cfg.max_fee_wei, "pyth: update fee exceeds pyth_max_fee_wei; NOT pushing (never overridden by --force-unprofitable)");
        return StepOutcome::FeeAboveCap { fee: fee64 };
    }

    // 5) simulate + quote
    let data = Bytes::from(IPyth::updatePriceFeedsCall { updateData: update.blobs.clone() }.abi_encode());
    match chain.simulate(&data, fee).await {
        Ok(Sim::Passed) => {}
        Ok(Sim::Skipped(why)) => info!(why, "pyth: simulation skipped"),
        Err(CallErr::Revert(k)) => {
            let wait = fail(st, "failed_sim");
            m.inc_revert("pyth_push", &k.label());
            let hint = if matches!(k, RevertKind::Unknown(_) | RevertKind::NoData) { " (InvalidUpdateData/InsufficientFee? check that Hermes serves the channel this Pyth contract expects: stable vs beta)" } else { "" };
            warn!(reason = %k.label(), retry_in_secs = wait, "pyth: updatePriceFeeds simulation reverted{hint}");
            return StepOutcome::SimFailed { backoff_secs: wait };
        }
        Err(CallErr::Transport(e)) => {
            let wait = fail(st, "failed_rpc");
            warn!(error = %e, retry_in_secs = wait, "pyth: simulation transport error");
            return StepOutcome::RpcFailed;
        }
    }
    let quote = match chain.quote(&data, fee).await {
        Ok(q) => q,
        Err(e) => {
            let wait = fail(st, "failed_rpc");
            warn!(error = %e, retry_in_secs = wait, "pyth: gas estimate failed; not pushing");
            return StepOutcome::RpcFailed;
        }
    };
    let cost = gas_cost_micro_usd(quote.gas, quote.max_fee_per_gas, env.native_usd_micro);
    let budget_micro = U256::from(usd_to_micro(cfg.max_gas_usd)) + U256::from(env.min_profit_micro);
    match decide(budget_micro, cost, U256::from(env.min_profit_micro), env.force) {
        Decision::Send => info!(est_gas_cost_usd = %fmt_micro(cost), gas = quote.gas, assumed = quote.assumed, fee_wei = fee64, forced = env.force, "pyth: gas gate passed"),
        Decision::SkipUnprofitable => {
            Metrics::inc_kind(&m.skipped_unprofitable, "pyth_push");
            m.inc_pyth("skipped_gas");
            st.next_run_unix = now_wall + 60;
            warn!(est_gas_cost_usd = %fmt_micro(cost), max_gas_usd = cfg.max_gas_usd, gas = quote.gas, "pyth: SKIPPING: estimated gas cost exceeds pyth_max_gas_usd (use --force-unprofitable to override)");
            return StepOutcome::GasAboveBudget;
        }
    }

    // 6) hourly budget: reserve fee + worst-case gas
    let worst_gas = u64::try_from((quote.gas_limit as u128).saturating_mul(quote.worst_fee_per_gas)).unwrap_or(u64::MAX);
    let projected = fee64.saturating_add(worst_gas);
    if !within_budget(spent, projected, cfg.hourly_budget_wei) {
        m.inc_pyth("skipped_budget");
        st.next_run_unix = now_wall + 60;
        warn!(spent_wei = spent, projected_wei = projected, budget_wei = cfg.hourly_budget_wei, "pyth: this push would exceed the hourly budget; not pushing");
        return StepOutcome::OverHourlyBudget;
    }

    // 7) send (or dry-run)
    if env.dry_run || !chain.can_send() {
        Metrics::inc_kind(&m.dry_run_actions, "pyth_push");
        m.inc_pyth("dry_run");
        info!(fee_wei = fee64, blobs = update.blobs.len(), projected_wei = projected, "DRY-RUN: pyth update simulated, would push");
        return StepOutcome::DryRun { fee: fee64 };
    }
    match chain.send(data, fee).await {
        Ok(sent) => {
            let gas_wei = u64::try_from(sent.cost_wei()).unwrap_or(u64::MAX);
            st.record(now_wall, fee64.saturating_add(gas_wei));
            st.pushes += 1;
            st.last_push_unix = now_wall;
            st.consecutive_failures = 0;
            m.inc_pyth("sent");
            Metrics::inc_kind(&m.txs_sent, "pyth_push");
            m.pyth_fee_wei.inc_by(fee64);
            m.pyth_gas_wei.inc_by(gas_wei);
            m.pyth_budget_spent_wei.set(st.spent_in_window(now_wall).min(i64::MAX as u64) as i64);
            m.pyth_backoff_seconds.set(0);
            info!(tx = %sent.hash, block = sent.block, fee_wei = fee64, gas_used = sent.gas_used, gas_wei, "pyth: prices pushed");
            StepOutcome::Sent { fee: fee64, gas_wei }
        }
        Err(e) => {
            // A timeout may still be mined, and a mined revert burned gas: book the worst case so the budget stays a ceiling.
            if matches!(e, SendError::Timeout(..) | SendError::MinedRevert(_)) {
                st.record(now_wall, projected);
            }
            Metrics::inc_kind(&m.tx_failures, "pyth_push");
            let wait = fail(st, "failed_tx");
            warn!(error = %e, retry_in_secs = wait, "pyth: push failed");
            StepOutcome::SendFailed { backoff_secs: wait }
        }
    }
}

fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish()
}

/// Called once per keeper tick (before funding/liquidation so later reads see the fresh price).
pub async fn run(ctx: &Ctx, st: &mut PythPersist, hermes: &HermesClient, head_timestamp: u64) -> StepOutcome {
    let cfg = &ctx.cfg.pyth;
    let chain = ChainPyth { chain: &ctx.chain, pyth: cfg.contract };
    let env = Env {
        cfg,
        metrics: &ctx.metrics,
        dry_run: ctx.cfg.dry_run,
        force: ctx.cfg.force_unprofitable,
        native_usd_micro: usd_to_micro(ctx.cfg.native_usd_price),
        min_profit_micro: u64::try_from(usd_to_micro(ctx.cfg.min_profit_usd)).unwrap_or(u64::MAX),
    };
    step(&env, st, hermes, &chain, head_timestamp, unix_now(), random_u64()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, RawConfig};
    use alloy::primitives::B256;
    use std::sync::Mutex;

    const NOW: u64 = 1_000_000;
    fn feed(n: u8) -> B256 { B256::repeat_byte(n) }

    #[test]
    fn due_when_any_feed_is_old_or_missing() {
        let s = |t| FeedStatus::Published(NOW - t);
        assert!(!any_due(&[s(10), s(1799)], NOW, 1800));
        assert!(any_due(&[s(10), s(1800)], NOW, 1800), "threshold is inclusive");
        assert!(any_due(&[s(10), FeedStatus::Missing], NOW, 1800));
        assert!(!any_due(&[s(10), FeedStatus::Unreadable], NOW, 1800), "unknown is not a reason to pay");
        assert!(!any_due(&[FeedStatus::Published(NOW + 50)], NOW, 1), "a future publishTime has age 0");
    }

    #[test]
    fn newer_data_check() {
        let ids = [feed(1), feed(2)];
        let st = [FeedStatus::Published(NOW - 2000), FeedStatus::Published(NOW - 10)];
        let mut h = HashMap::new();
        assert!(hermes_has_newer(&ids, &st, NOW, 1800, &h), "no parsed section: assume yes");
        h.insert(ids[0], NOW - 2000);
        assert!(!hermes_has_newer(&ids, &st, NOW, 1800, &h), "same publish_time as on-chain: nothing to gain");
        h.insert(ids[0], NOW - 5);
        assert!(hermes_has_newer(&ids, &st, NOW, 1800, &h));
        // only a due feed counts
        let mut h2 = HashMap::new();
        h2.insert(ids[0], NOW - 2000);
        h2.insert(ids[1], NOW);
        assert!(!hermes_has_newer(&ids, &st, NOW, 1800, &h2));
        assert!(hermes_has_newer(&ids, &[FeedStatus::Missing, st[1]], NOW, 1800, &h2), "a missing feed is always worth pushing");
    }

    #[test]
    fn backoff_policy() {
        let e5 = HermesError::Server(503);
        assert_eq!([1, 2, 3, 4, 7, 30].map(|n| backoff_secs(&e5, n)), [5, 10, 20, 40, 300, 300]);
        let auth = HermesError::Unauthorized(401);
        assert_eq!([1, 2, 3, 4, 5, 9].map(|n| backoff_secs(&auth, n)), [60, 120, 240, 480, 900, 900]);
        let rl = HermesError::RateLimited { retry_after_secs: Some(120) };
        assert_eq!(backoff_secs(&rl, 1), 120, "Retry-After wins when longer");
        assert_eq!(backoff_secs(&HermesError::RateLimited { retry_after_secs: None }, 1), 10);
        assert_eq!(backoff_secs(&HermesError::RateLimited { retry_after_secs: Some(999_999) }, 1), RATE_LIMIT_CAP_SECS, "absurd Retry-After is capped");
        assert_eq!(generic_backoff_secs(0), 5);
        assert_eq!(generic_backoff_secs(u32::MAX), 300, "no overflow");
    }

    #[test]
    fn jitter_stays_within_bounds() {
        for r in [0u64, 1, 7, 12345, u64::MAX] {
            let j = jittered(20, 10, r);
            assert!((18..=22).contains(&j), "{j}");
        }
        assert_eq!(jittered(20, 0, 99), 20);
        assert_eq!(jittered(0, 10, 99), 1, "never zero");
        assert_eq!(jittered(3, 10, 99), 3, "deviation rounds to 0 for tiny values");
    }

    #[test]
    fn budget_is_a_hard_ceiling_over_a_rolling_hour() {
        let mut st = PythPersist::default();
        st.record(100, 400);
        st.record(200, 400);
        assert_eq!(st.spent_in_window(300), 800);
        assert!(within_budget(800, 200, 1000));
        assert!(!within_budget(800, 201, 1000));
        assert!(!within_budget(u64::MAX, 1, u64::MAX), "saturating");
        // the first entry leaves the window after an hour
        assert_eq!(st.spent_in_window(100 + BUDGET_WINDOW_SECS), 400);
        st.prune(100 + BUDGET_WINDOW_SECS);
        assert_eq!(st.ledger.len(), 1);
        assert_eq!(st.total_spent_wei, 800, "lifetime total is kept");
    }

    #[test]
    fn persist_roundtrips_and_old_checkpoints_load() {
        let mut st = PythPersist::default();
        st.record(5, 7);
        let j = serde_json::to_string(&st).unwrap();
        assert_eq!(serde_json::from_str::<PythPersist>(&j).unwrap(), st);
        // a pre-feature checkpoint has no `pyth` key at all
        let old = crate::state::State::new("0x1".into(), 0);
        let mut v = serde_json::to_value(&old).unwrap();
        v.as_object_mut().unwrap().remove("pyth");
        let back: crate::state::State = serde_json::from_value(v).unwrap();
        assert_eq!(back.pyth, PythPersist::default());
    }

    #[test]
    fn status_classification() {
        assert_eq!(classify_status(200, None), None);
        assert_eq!(classify_status(401, None), Some(HermesError::Unauthorized(401)));
        assert_eq!(classify_status(403, None), Some(HermesError::Unauthorized(403)));
        assert_eq!(classify_status(429, Some(" 17 ")), Some(HermesError::RateLimited { retry_after_secs: Some(17) }));
        assert_eq!(classify_status(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")), Some(HermesError::RateLimited { retry_after_secs: None }));
        assert_eq!(classify_status(502, None), Some(HermesError::Server(502)));
        assert_eq!(classify_status(404, None), Some(HermesError::Client(404)));
    }

    #[test]
    fn real_hermes_response_shape_is_accepted() {
        // shape observed from the live service: price/conf are integer STRINGS, expo/publish_time integers, extra fields present
        let id = format!("{:x}", feed(0xab));
        let body = format!(r#"{{"binary":{{"encoding":"hex","data":["504e41550100000003b801"]}},"parsed":[{{"id":"{id}","price":{{"price":"6512345678901","conf":"3456789","expo":-8,"publish_time":1789000000}},"ema_price":{{"price":"1","conf":"1","expo":-8,"publish_time":1789000000}},"metadata":{{"slot":1,"proof_available_time":1,"prev_publish_time":1}}}}]}}"#);
        let u = parse_hermes_body(body.as_bytes()).unwrap();
        assert_eq!(u.blobs.len(), 1);
        assert_eq!(u.publish_times[&feed(0xab)], 1_789_000_000);
        assert_eq!(u.prices[&feed(0xab)], (6_512_345_678_901, 3_456_789, -8));
    }

    #[test]
    fn hermes_body_parsing() {
        let id = format!("{:x}", feed(0xab));
        let body = format!(r#"{{"binary":{{"encoding":"hex","data":["deadbeef","0xcafe"]}},"parsed":[{{"id":"{id}","price":{{"price":"1","publish_time":1234}}}}]}}"#);
        let u = parse_hermes_body(body.as_bytes()).unwrap();
        assert_eq!(u.blobs, vec![Bytes::from(vec![0xde, 0xad, 0xbe, 0xef]), Bytes::from(vec![0xca, 0xfe])]);
        assert_eq!(u.publish_times.get(&feed(0xab)), Some(&1234));
        // parsed is optional
        assert!(parse_hermes_body(br#"{"binary":{"data":["00"]}}"#).unwrap().publish_times.is_empty());
        for bad in [&b"not json"[..], br#"{"binary":{"data":[]}}"#, br#"{"binary":{"data":["zz"]}}"#, br#"{"binary":{"data":[""]}}"#, br#"{}"#] {
            assert!(matches!(parse_hermes_body(bad), Err(HermesError::BadBody(_))), "{}", String::from_utf8_lossy(bad));
        }
    }

    // ---------------------------------------------------------------------------------------------- mocks for `step`

    struct MockHermes {
        replies: Mutex<Vec<Result<HermesUpdate, HermesError>>>,
        calls: Mutex<u32>,
    }
    impl MockHermes {
        fn new(r: Vec<Result<HermesUpdate, HermesError>>) -> MockHermes { MockHermes { replies: Mutex::new(r), calls: Mutex::new(0) } }
        fn calls(&self) -> u32 { *self.calls.lock().unwrap() }
    }
    impl Hermes for MockHermes {
        async fn latest(&self, _ids: &[B256]) -> Result<HermesUpdate, HermesError> {
            *self.calls.lock().unwrap() += 1;
            let mut r = self.replies.lock().unwrap();
            if r.len() > 1 { r.remove(0) } else { r[0].clone() }
        }
    }
    fn update(times: &[(u8, u64)]) -> HermesUpdate {
        HermesUpdate { blobs: vec![Bytes::from(vec![1, 2, 3])], publish_times: times.iter().map(|(n, t)| (feed(*n), *t)).collect(), prices: HashMap::new() }
    }

    struct MockChain {
        times: Vec<Result<u64, CallErr>>,
        fee: Result<U256, CallErr>,
        sim: Result<(), CallErr>,
        gas: u64,
        fee_per_gas: u128,
        worst_fee_per_gas: u128,
        signer: bool,
        send: Mutex<Vec<Result<Sent, SendError>>>,
        sent: Mutex<Vec<(Bytes, U256)>>,
    }
    impl MockChain {
        fn new(ages: &[u64]) -> MockChain {
            MockChain {
                times: ages.iter().map(|a| Ok(NOW - a)).collect(),
                fee: Ok(U256::from(2u64)),
                sim: Ok(()),
                gas: 200_000,
                fee_per_gas: 100_000_000, // 0.1 gwei
                worst_fee_per_gas: 200_000_000,
                signer: true,
                send: Mutex::new(vec![]),
                sent: Mutex::new(vec![]),
            }
        }
        fn mined() -> Result<Sent, SendError> {
            Ok(Sent { hash: B256::repeat_byte(9), gas_used: 150_000, block: 7, attempts: 1, effective_gas_price: 100_000_000 })
        }
    }
    impl PythChain for MockChain {
        async fn publish_time(&self, feed_id: B256) -> Result<u64, CallErr> {
            let i = (feed_id.0[0] - 1) as usize;
            self.times[i].clone()
        }
        async fn update_fee(&self, _u: &[Bytes]) -> Result<U256, CallErr> { self.fee.clone() }
        async fn simulate(&self, _d: &Bytes, _v: U256) -> Result<Sim, CallErr> { self.sim.clone().map(|_| Sim::Passed) }
        async fn quote(&self, _d: &Bytes, _v: U256) -> Result<Quote, CallErr> {
            Ok(Quote { gas: self.gas, gas_limit: self.gas * 125 / 100, max_fee_per_gas: self.fee_per_gas, worst_fee_per_gas: self.worst_fee_per_gas, assumed: false })
        }
        async fn send(&self, d: Bytes, v: U256) -> Result<Sent, SendError> {
            self.sent.lock().unwrap().push((d, v));
            let mut q = self.send.lock().unwrap();
            if q.is_empty() { MockChain::mined() } else { q.remove(0) }
        }
        fn can_send(&self) -> bool { self.signer }
    }

    fn cfg_with(edit: impl FnOnce(&mut RawConfig)) -> Config {
        let mut r = RawConfig {
            rpc_url: Some("http://127.0.0.1:1".into()),
            exchange: Some("0x5FbDB2315678afecb367f032d93F642f64180aa3".into()),
            enable_pyth_push: Some(true),
            pyth_contract: Some("0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF".into()),
            pyth_feed_ids: Some(vec![format!("BTC={:#x}", feed(1)), format!("ETH={:#x}", feed(2))]),
            pyth_jitter_pct: Some(0),
            ..Default::default()
        };
        edit(&mut r);
        Config::from_raw(r).unwrap()
    }

    struct Fx {
        cfg: Config,
        metrics: Metrics,
        st: PythPersist,
    }
    impl Fx {
        fn new() -> Fx { Fx::with(|_| {}) }
        fn with(edit: impl FnOnce(&mut RawConfig)) -> Fx { Fx { cfg: cfg_with(edit), metrics: Metrics::new(), st: PythPersist::default() } }
        async fn step<H: Hermes, C: PythChain>(&mut self, h: &H, c: &C, dry: bool, force: bool, now_wall: u64) -> StepOutcome {
            let env = Env { cfg: &self.cfg.pyth, metrics: &self.metrics, dry_run: dry, force, native_usd_micro: 3_000_000_000, min_profit_micro: 0 };
            step(&env, &mut self.st, h, c, NOW, now_wall, 0).await
        }
        fn count(&self, result: &str) -> u64 {
            self.metrics.pyth_push.get_or_create(&crate::metrics::ResultLabel { result: result.into() }).get()
        }
    }

    #[tokio::test]
    async fn fresh_prices_never_touch_hermes_or_the_wallet() {
        let mut fx = Fx::new();
        let (h, c) = (MockHermes::new(vec![Ok(update(&[]))]), MockChain::new(&[10, 1799]));
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::Fresh);
        assert_eq!(h.calls(), 0);
        assert!(c.sent.lock().unwrap().is_empty());
        assert_eq!(fx.count("skipped_fresh"), 1);
        let out = fx.metrics.render();
        assert!(out.contains("keeper_pyth_age_seconds{feed=\"BTC\"} 10"), "{out}");
        assert!(out.contains("keeper_pyth_age_seconds{feed=\"ETH\"} 1799"), "{out}");
        // and the next check is scheduled one interval out
        assert_eq!(fx.st.next_run_unix, 5000 + 20);
        assert_eq!(fx.step(&h, &c, false, false, 5001).await, StepOutcome::Idle);
    }

    #[tokio::test]
    async fn stale_feed_is_pushed_with_the_quoted_fee_and_the_spend_is_booked() {
        let mut fx = Fx::new();
        let (h, c) = (MockHermes::new(vec![Ok(update(&[(1, NOW - 1), (2, NOW - 1)]))]), MockChain::new(&[1800, 5]));
        let out = fx.step(&h, &c, false, false, 5000).await;
        // 150k gas * 0.1 gwei = 1.5e13 wei, fee 2 wei
        assert_eq!(out, StepOutcome::Sent { fee: 2, gas_wei: 15_000_000_000_000 });
        let sent = c.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, U256::from(2u64), "value == getUpdateFee");
        assert_eq!(&sent[0].0[..4], IPyth::updatePriceFeedsCall::SELECTOR.as_slice());
        assert_eq!(fx.st.pushes, 1);
        assert_eq!(fx.st.spent_in_window(5000), 15_000_000_000_002);
        assert_eq!(fx.count("sent"), 1);
        let m = fx.metrics.render();
        assert!(m.contains("keeper_pyth_fee_wei_total 2"), "{m}");
        assert!(m.contains("keeper_pyth_gas_wei_total 15000000000000"), "{m}");
        assert!(m.contains("keeper_txs_sent_total{kind=\"pyth_push\"} 1"), "{m}");
    }

    #[tokio::test]
    async fn dry_run_simulates_but_never_sends_and_books_nothing() {
        let mut fx = Fx::new();
        let (h, c) = (MockHermes::new(vec![Ok(update(&[]))]), MockChain::new(&[4000, 5]));
        assert_eq!(fx.step(&h, &c, true, false, 5000).await, StepOutcome::DryRun { fee: 2 });
        assert!(c.sent.lock().unwrap().is_empty());
        assert!(fx.st.ledger.is_empty());
        assert_eq!(fx.count("dry_run"), 1);
        // no signer behaves like dry-run even when dry_run=false
        let mut c2 = MockChain::new(&[4000, 5]);
        c2.signer = false;
        let mut fx2 = Fx::new();
        assert_eq!(fx2.step(&h, &c2, false, false, 5000).await, StepOutcome::DryRun { fee: 2 });
        assert!(c2.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn hermes_401_backs_off_without_panicking_and_does_not_send() {
        let mut fx = Fx::new();
        let (h, c) = (MockHermes::new(vec![Err(HermesError::Unauthorized(401))]), MockChain::new(&[4000, 5]));
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::HermesFailed { kind: "unauthorized", backoff_secs: 60 });
        assert_eq!(fx.st.next_run_unix, 5060);
        assert_eq!(fx.step(&h, &c, false, false, 5059).await, StepOutcome::Idle, "no retry storm during the backoff");
        assert_eq!(h.calls(), 1);
        // second failure doubles
        assert_eq!(fx.step(&h, &c, false, false, 5060).await, StepOutcome::HermesFailed { kind: "unauthorized", backoff_secs: 120 });
        assert!(c.sent.lock().unwrap().is_empty());
        let m = fx.metrics.render();
        assert!(m.contains("keeper_pyth_hermes_errors_total{kind=\"unauthorized\"} 2"), "{m}");
        assert!(m.contains("keeper_pyth_push_total{result=\"failed_hermes\"} 2"), "{m}");
        assert!(m.contains("keeper_pyth_backoff_seconds 120"), "{m}");
    }

    #[tokio::test]
    async fn rate_limit_honours_retry_after_and_recovery_resets_the_backoff() {
        let mut fx = Fx::new();
        let h = MockHermes::new(vec![Err(HermesError::RateLimited { retry_after_secs: Some(90) }), Ok(update(&[]))]);
        let c = MockChain::new(&[4000, 5]);
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::HermesFailed { kind: "rate_limited", backoff_secs: 90 });
        assert!(matches!(fx.step(&h, &c, false, false, 5090).await, StepOutcome::Sent { .. }));
        assert_eq!(fx.st.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn server_errors_and_network_errors_back_off_exponentially() {
        let mut fx = Fx::new();
        let h = MockHermes::new(vec![Err(HermesError::Server(503)), Err(HermesError::Network("connection refused".into()))]);
        let c = MockChain::new(&[4000, 5]);
        assert_eq!(fx.step(&h, &c, false, false, 0).await, StepOutcome::HermesFailed { kind: "server", backoff_secs: 5 });
        assert_eq!(fx.step(&h, &c, false, false, 5).await, StepOutcome::HermesFailed { kind: "network", backoff_secs: 10 });
    }

    #[tokio::test]
    async fn no_newer_hermes_data_means_no_paid_push() {
        let mut fx = Fx::new();
        let (h, c) = (MockHermes::new(vec![Ok(update(&[(1, NOW - 4000), (2, NOW - 5)]))]), MockChain::new(&[4000, 5]));
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::NoNewerData);
        assert!(c.sent.lock().unwrap().is_empty());
        assert_eq!(fx.count("skipped_no_newer"), 1);
    }

    #[tokio::test]
    async fn fee_cap_is_hard_even_when_forced() {
        let mut fx = Fx::with(|r| r.pyth_max_fee_wei = Some(10));
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let mut c = MockChain::new(&[4000, 5]);
        c.fee = Ok(U256::from(11u64));
        assert_eq!(fx.step(&h, &c, false, true, 5000).await, StepOutcome::FeeAboveCap { fee: 11 });
        assert!(c.sent.lock().unwrap().is_empty());
        c.fee = Ok(U256::from(10u64));
        assert!(matches!(fx.step(&h, &c, false, true, 6000).await, StepOutcome::Sent { .. }), "exactly at the cap is allowed");
    }

    #[tokio::test]
    async fn gas_gate_skips_unless_forced() {
        // 200k gas * 100 gwei = 0.02 ETH = $60 at $3000, budget $0.50
        let mut c = MockChain::new(&[4000, 5]);
        c.fee_per_gas = 100_000_000_000;
        c.worst_fee_per_gas = 100_000_000_000;
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let mut fx = Fx::with(|r| r.pyth_hourly_budget_wei = Some(u64::MAX));
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::GasAboveBudget);
        assert!(c.sent.lock().unwrap().is_empty());
        assert_eq!(fx.count("skipped_gas"), 1);
        assert!(fx.metrics.render().contains("keeper_skipped_unprofitable_total{kind=\"pyth_push\"} 1"));
        assert!(matches!(fx.step(&h, &c, false, true, 6000).await, StepOutcome::Sent { .. }), "--force-unprofitable overrides the gas gate");
    }

    #[tokio::test]
    async fn hourly_budget_is_never_exceeded_even_when_forced() {
        // reserved per push: 2 wei + 250k * 0.2 gwei = 5e13 wei; actual spend is 1.5e13 each, so 4 pushes fit
        // (spent 4.5e13 <= 5e13 admits the 4th; 6e13 does not admit a 5th)
        let mut fx = Fx::with(|r| r.pyth_hourly_budget_wei = Some(100_000_000_000_004));
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let c = MockChain::new(&[4000, 5]);
        let mut sent = 0;
        let mut t = 5000;
        let mut outcomes = vec![];
        for _ in 0..6 {
            let o = fx.step(&h, &c, false, true, t).await;
            if matches!(o, StepOutcome::Sent { .. }) { sent += 1; }
            outcomes.push(o);
            t += 61; // past the 60 s hold-off, well inside the hour
        }
        assert_eq!(sent, 4, "{outcomes:?}");
        assert!(fx.st.spent_in_window(t) <= 100_000_000_000_004);
        assert!(outcomes.contains(&StepOutcome::OverHourlyBudget));
        assert!(fx.count("skipped_budget") >= 1);
        // an hour later the window has moved on and pushing resumes
        assert!(matches!(fx.step(&h, &c, false, true, 5000 + BUDGET_WINDOW_SECS + 1).await, StepOutcome::Sent { .. }));
    }

    #[tokio::test]
    async fn timed_out_sends_are_booked_at_worst_case() {
        let mut fx = Fx::new();
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let c = MockChain::new(&[4000, 5]);
        *c.send.lock().unwrap() = vec![Err(SendError::Timeout(4, vec![])), Err(SendError::Rpc("boom".into()))];
        let o = fx.step(&h, &c, false, false, 5000).await;
        assert!(matches!(o, StepOutcome::SendFailed { backoff_secs: 5 }), "{o:?}");
        assert_eq!(fx.st.spent_in_window(5000), 2 + 250_000 * 200_000_000, "might still be mined: reserve the worst case");
        // a plain RPC error before broadcast books nothing
        let before = fx.st.spent_in_window(5005);
        let o = fx.step(&h, &c, false, false, 5005).await;
        assert!(matches!(o, StepOutcome::SendFailed { .. }));
        assert_eq!(fx.st.spent_in_window(5005), before);
        assert_eq!(fx.metrics.render().matches("keeper_tx_failures_total{kind=\"pyth_push\"} 2").count(), 1);
    }

    #[tokio::test]
    async fn simulation_revert_blocks_the_send_and_backs_off() {
        let mut fx = Fx::new();
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let mut c = MockChain::new(&[4000, 5]);
        c.sim = Err(CallErr::Revert(RevertKind::Unknown("0x08c379a0".into())));
        assert_eq!(fx.step(&h, &c, false, true, 5000).await, StepOutcome::SimFailed { backoff_secs: 5 });
        assert!(c.sent.lock().unwrap().is_empty());
        assert_eq!(fx.count("failed_sim"), 1);
        assert!(fx.metrics.render().contains("keeper_sim_reverts_total{kind=\"pyth_push\""));
    }

    #[tokio::test]
    async fn never_published_feed_triggers_a_push_and_unreadable_chain_does_not() {
        let mut fx = Fx::new();
        let h = MockHermes::new(vec![Ok(update(&[]))]);
        let mut c = MockChain::new(&[5, 5]);
        c.times[0] = Err(CallErr::Revert(RevertKind::Unknown("0xa9cb9e0d".into()))); // PriceFeedNotFound
        assert!(matches!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::Sent { .. }));
        let mut fx = Fx::new();
        let mut c = MockChain::new(&[4000, 5]);
        c.times[1] = Err(CallErr::Transport("connection reset".into()));
        assert_eq!(fx.step(&h, &c, false, false, 5000).await, StepOutcome::RpcFailed);
        assert_eq!(h.calls(), 1, "Hermes untouched when the chain read failed");
    }

    #[test]
    fn config_validation() {
        let id = format!("{:#x}", feed(1));
        let base = |f: &dyn Fn(&mut RawConfig)| {
            let mut r = RawConfig {
                rpc_url: Some("http://x".into()),
                exchange: Some("0x5FbDB2315678afecb367f032d93F642f64180aa3".into()),
                enable_pyth_push: Some(true),
                pyth_contract: Some("0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF".into()),
                pyth_feed_ids: Some(vec![id.clone()]),
                ..Default::default()
            };
            f(&mut r);
            Config::from_raw(r)
        };
        let c = base(&|_| {}).unwrap();
        assert!(c.enable_pyth_push);
        assert_eq!((c.pyth.push_interval_secs, c.pyth.max_age_secs, c.pyth.push_when_age_secs), (20, 3600, 1800));
        assert_eq!(c.pyth.hermes_url.expose(), "https://pyth.dourolabs.app/hermes");
        assert_eq!((c.pyth.api_key_header.as_str(), c.pyth.api_key_prefix.as_str()), ("Authorization", "Bearer "));
        assert!(c.pyth.feeds[0].0.starts_with("0x"), "default label comes from the id");
        assert!(base(&|r| r.pyth_contract = None).is_err());
        assert!(base(&|r| r.pyth_feed_ids = Some(vec![])).is_err());
        assert!(base(&|r| r.pyth_feed_ids = Some(vec!["0x1234".into()])).is_err());
        assert!(base(&|r| r.pyth_feed_ids = Some(vec![id.clone(), id.clone()])).is_err(), "duplicate ids");
        assert!(base(&|r| r.pyth_push_when_age_secs = Some(3600)).is_err(), "threshold must be below maxAge");
        assert!(base(&|r| r.pyth_push_when_age_secs = Some(0)).is_err());
        assert!(base(&|r| r.hermes_url = Some("ftp://x".into())).is_err());
        assert!(base(&|r| r.hermes_api_key_header = Some("bad header".into())).is_err());
        assert!(base(&|r| r.pyth_jitter_pct = Some(51)).is_err());
        assert_eq!(base(&|r| r.pyth_max_age_secs = Some(600)).unwrap().pyth.push_when_age_secs, 300);
    }

    #[test]
    fn disabled_feature_needs_no_pyth_settings() {
        let c = Config::from_raw(RawConfig { rpc_url: Some("http://x".into()), exchange: Some("0x5FbDB2315678afecb367f032d93F642f64180aa3".into()), ..Default::default() }).unwrap();
        assert!(!c.enable_pyth_push);
        // junk pyth values are ignored while disabled
        let c = Config::from_raw(RawConfig { rpc_url: Some("http://x".into()), exchange: Some("0x5FbDB2315678afecb367f032d93F642f64180aa3".into()), pyth_contract: Some("junk".into()), ..Default::default() }).unwrap();
        assert!(!c.enable_pyth_push);
    }

    #[test]
    fn secrets_never_reach_debug_output() {
        let url = SecretUrl::parse("https://user:pw@hermes.example.com:8443/path-token-SECRET123/?apikey=SECRET456").unwrap();
        for s in [format!("{url:?}"), url.redacted()] {
            assert!(!s.contains("SECRET") && !s.contains("pw@") && !s.contains("user"), "{s}");
            assert!(s.starts_with("https://hermes.example.com:8443"), "{s}");
        }
        let c = cfg_with(|r| r.hermes_url = Some("https://h.example/SECRET789?k=SECRET790".into()));
        assert!(!format!("{c:?}").contains("SECRET"));
        let client = HermesClient::build(&url, "x-api-key", "", Some("KEYVALUE-XYZ"), Duration::from_secs(1)).unwrap();
        let d = format!("{client:?}");
        assert!(!d.contains("KEYVALUE") && !d.contains("SECRET") && d.contains("x-api-key"), "{d}");
        assert!(client.has_auth());
        // the request URL keeps the key-bearing path/query of an alternative base URL
        let u = client.request_url(&[feed(1)]).to_string();
        assert!(u.contains("/path-token-SECRET123/v2/updates/price/latest?apikey=SECRET456&ids%5B%5D=") || u.contains("ids[]="), "{u}");
        // a malformed key is rejected without echoing it
        let e = HermesClient::build(&url, "x-api-key", "", Some("bad\nkey-LEAK"), Duration::from_secs(1)).unwrap_err().to_string();
        assert!(!e.contains("LEAK"), "{e}");
    }
}
