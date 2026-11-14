//! Multi-endpoint RPC failover: a pure health/rotation `Selector` plus a transport that uses it.
//!
//! Policy: stay on the active endpoint while it works (sticky). A transport-level failure (connection error, HTTP error,
//! undecodable body, JSON-RPC "rate limited") marks that endpoint down for `cooldown`, rotates to the next healthy one and
//! retries the same request there. Node-level answers (including reverts) are NOT failures and are returned as is.
//! A periodic probe (`update_heads`) re-admits recovered endpoints, demotes ones that lag the best head by more than
//! `max_lag` blocks, and fails back to the lowest-index (preferred) healthy endpoint.
use alloy::{
    rpc::json_rpc::{RequestPacket, ResponsePacket},
    transports::{http::Http, TransportError, TransportFut},
};
use std::{
    sync::{Arc, Mutex},
    task,
    time::{Duration, Instant},
};
use tower::Service;
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub struct Selector {
    n: usize,
    active: usize,
    down_until: Vec<Option<Instant>>,
    cooldown: Duration,
    max_lag: u64,
}

impl Selector {
    pub fn new(n: usize, cooldown: Duration, max_lag: u64) -> Selector {
        assert!(n > 0, "at least one endpoint");
        Selector { n, active: 0, down_until: vec![None; n], cooldown, max_lag }
    }

    pub fn active(&self) -> usize { self.active }

    pub fn is_down(&self, i: usize, now: Instant) -> bool {
        matches!(self.down_until[i], Some(t) if now < t)
    }

    /// Endpoints to try for the next request: the active one first, then healthy ones by index, then (last resort, so a
    /// total outage still retries everything) endpoints that are cooling down.
    pub fn order(&self, now: Instant) -> Vec<usize> {
        let mut healthy = vec![];
        let mut down = vec![];
        for k in 0..self.n {
            let i = (self.active + k) % self.n;
            if self.is_down(i, now) { down.push(i) } else { healthy.push(i) }
        }
        healthy.extend(down);
        healthy
    }

    pub fn report_ok(&mut self, i: usize) {
        self.down_until[i] = None;
        self.active = i;
    }

    /// Mark `i` down; if it was the active one, rotate to the next healthy endpoint (or just the next one).
    pub fn report_err(&mut self, i: usize, now: Instant) {
        self.down_until[i] = Some(now + self.cooldown);
        if self.active == i {
            self.active = (1..=self.n).map(|k| (i + k) % self.n).find(|j| !self.is_down(*j, now)).unwrap_or((i + 1) % self.n);
        }
    }

    /// Apply the result of a health probe. `heads[i]` = block number reported by endpoint `i`, `None` = unreachable.
    /// Returns the (possibly changed) active index.
    pub fn update_heads(&mut self, heads: &[Option<u64>], now: Instant) -> usize {
        let best = heads.iter().flatten().copied().max();
        let mut healthy = vec![false; self.n];
        for (i, h) in heads.iter().enumerate().take(self.n) {
            healthy[i] = match (h, best) {
                (Some(h), Some(b)) => b.saturating_sub(*h) <= self.max_lag,
                _ => false,
            };
            if healthy[i] {
                self.down_until[i] = None;
            } else {
                self.down_until[i] = Some(now + self.cooldown);
            }
        }
        // fail back to the preferred (lowest index) healthy endpoint; if nothing is healthy keep the current one
        if let Some(i) = healthy.iter().position(|h| *h) {
            self.active = i;
        }
        self.active
    }
}

/// True when an error means "this endpoint is unusable" (as opposed to a legitimate node answer such as a revert).
pub fn is_endpoint_failure(e: &TransportError) -> bool {
    use alloy::transports::RpcError;
    match e {
        RpcError::Transport(_) | RpcError::DeserError { .. } => true,
        RpcError::ErrorResp(p) => {
            let m = p.message.to_ascii_lowercase();
            p.code == -32005 || m.contains("rate limit") || m.contains("too many requests")
        }
        _ => false,
    }
}

/// JSON-RPC transport over several HTTP endpoints with automatic rotation.
#[derive(Clone)]
pub struct FailoverTransport {
    endpoints: Arc<Vec<Http<alloy::transports::http::reqwest::Client>>>,
    sel: Arc<Mutex<Selector>>,
}

impl FailoverTransport {
    pub fn new(urls: &[url_parse::Url], cooldown: Duration, max_lag: u64) -> (FailoverTransport, Arc<Mutex<Selector>>) {
        let eps = urls.iter().map(|u| Http::new(u.clone())).collect::<Vec<_>>();
        let sel = Arc::new(Mutex::new(Selector::new(eps.len(), cooldown, max_lag)));
        (FailoverTransport { endpoints: Arc::new(eps), sel: sel.clone() }, sel)
    }
}

/// `url::Url` as re-exported through reqwest.
pub mod url_parse {
    pub use alloy::transports::http::reqwest::Url;
}

impl Service<RequestPacket> for FailoverTransport {
    type Response = ResponsePacket;
    type Error = TransportError;
    type Future = TransportFut<'static>;

    fn poll_ready(&mut self, _cx: &mut task::Context<'_>) -> task::Poll<Result<(), Self::Error>> { task::Poll::Ready(Ok(())) }

    fn call(&mut self, req: RequestPacket) -> Self::Future {
        let this = self.clone();
        Box::pin(async move {
            let order = this.sel.lock().expect("selector").order(Instant::now());
            let mut last: Option<TransportError> = None;
            for i in order {
                let mut ep = this.endpoints[i].clone();
                match ep.call(req.clone()).await {
                    Ok(r) => {
                        let mut s = this.sel.lock().expect("selector");
                        let prev = s.active();
                        s.report_ok(i);
                        if prev != i {
                            info!(from = prev, to = i, "rpc failover: switched endpoint");
                        }
                        return Ok(r);
                    }
                    Err(e) if is_endpoint_failure(&e) => {
                        warn!(endpoint = i, error = %e, "rpc endpoint failed; rotating");
                        this.sel.lock().expect("selector").report_err(i, Instant::now());
                        last = Some(e);
                    }
                    Err(e) => return Err(e),
                }
            }
            Err(last.expect("selector order is never empty"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(n: usize) -> Selector { Selector::new(n, Duration::from_secs(30), 5) }

    #[test]
    fn sticky_until_failure_then_rotates() {
        let now = Instant::now();
        let mut s = sel(3);
        assert_eq!(s.order(now), vec![0, 1, 2]);
        s.report_ok(0);
        assert_eq!(s.active(), 0);
        s.report_err(0, now);
        assert_eq!(s.active(), 1);
        // down endpoint is tried last
        assert_eq!(s.order(now), vec![1, 2, 0]);
        s.report_err(1, now);
        assert_eq!(s.active(), 2);
        assert_eq!(s.order(now), vec![2, 0, 1]);
    }

    #[test]
    fn cooldown_expires() {
        let now = Instant::now();
        let mut s = sel(2);
        s.report_err(0, now);
        assert!(s.is_down(0, now));
        assert!(s.is_down(0, now + Duration::from_secs(29)));
        assert!(!s.is_down(0, now + Duration::from_secs(31)));
    }

    #[test]
    fn all_down_still_returns_every_endpoint() {
        let now = Instant::now();
        let mut s = sel(2);
        s.report_err(0, now);
        s.report_err(1, now);
        let o = s.order(now);
        assert_eq!(o.len(), 2);
    }

    #[test]
    fn probe_demotes_laggard_and_fails_back_to_primary() {
        let now = Instant::now();
        let mut s = sel(3);
        s.report_err(0, now); // primary failed, now on 1
        assert_eq!(s.active(), 1);
        // primary recovers and is in sync => fail back
        assert_eq!(s.update_heads(&[Some(100), Some(100), Some(99)], now), 0);
        // primary lags by 10 > 5 => demoted, move to the next healthy
        assert_eq!(s.update_heads(&[Some(90), Some(100), Some(100)], now), 1);
        assert!(s.is_down(0, now));
        // unreachable endpoint is down
        s.update_heads(&[None, Some(100), None], now);
        assert!(s.is_down(2, now) && s.is_down(0, now) && !s.is_down(1, now));
        // nothing reachable: keep current, do not panic
        assert_eq!(s.update_heads(&[None, None, None], now), 1);
    }

    #[test]
    fn failure_classification() {
        use alloy::transports::{RpcError, TransportErrorKind};
        assert!(is_endpoint_failure(&TransportErrorKind::custom_str("conn refused")));
        assert!(is_endpoint_failure(&TransportErrorKind::http_error(502, "bad gateway".into())));
        let revert = RpcError::ErrorResp(alloy::rpc::json_rpc::ErrorPayload { code: 3, message: "execution reverted".into(), data: None });
        assert!(!is_endpoint_failure(&revert));
        let rl = RpcError::ErrorResp(alloy::rpc::json_rpc::ErrorPayload { code: -32005, message: "limit exceeded".into(), data: None });
        assert!(is_endpoint_failure(&rl));
        let rl2 = RpcError::ErrorResp(alloy::rpc::json_rpc::ErrorPayload { code: -32000, message: "Too Many Requests".into(), data: None });
        assert!(is_endpoint_failure(&rl2));
    }
}
