//! Edge hardening for the public API: CORS allowlist, optional read-only API keys (hashed at rest), per-key and
//! per-IP rate limits, and trusted-proxy `X-Forwarded-For` handling. Everything here is opt-in / conservative by
//! default: no proxy is trusted, only localhost origins are allowed, API keys are optional.
use crate::ratelimit::Limiter;
use crate::store::{ApiKeyRec, EventStore};
use alloy_primitives::keccak256;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};

// ------------------------------------------------------------------------------------------------ CIDR

/// `addr/prefix` (a bare address is a /32 or /128).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cidr {
    addr: IpAddr,
    prefix: u8,
}

impl Cidr {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let (a, p) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = a.trim().parse().map_err(|_| anyhow::anyhow!("bad IP in CIDR {s:?}"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match p {
            Some(p) => p.trim().parse::<u8>().map_err(|_| anyhow::anyhow!("bad prefix in CIDR {s:?}"))?,
            None => max,
        };
        anyhow::ensure!(prefix <= max, "prefix too long in CIDR {s:?}");
        // normalise an IPv4-mapped IPv6 CIDR (::ffff:a.b.c.d/p) to IPv4
        if let IpAddr::V6(v6) = addr {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return Ok(Self {
                    addr: IpAddr::V4(v4),
                    prefix: prefix.saturating_sub(96),
                });
            }
        }
        Ok(Self { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        fn bits(ip: IpAddr) -> (u128, u32) {
            match ip {
                IpAddr::V4(v) => (u32::from(v) as u128, 32),
                IpAddr::V6(v) => (u128::from(v), 128),
            }
        }
        // an IPv4-mapped IPv6 peer (::ffff:a.b.c.d) is matched as IPv4
        let norm = |ip: IpAddr| match ip {
            IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v)),
            o => o,
        };
        let (a, an) = bits(self.addr);
        let (b, bn) = bits(norm(ip));
        if an != bn {
            return false;
        }
        if self.prefix == 0 {
            return true;
        }
        let shift = an - self.prefix as u32;
        (a >> shift) == (b >> shift)
    }
}

pub fn parse_cidrs(list: &str) -> anyhow::Result<Vec<Cidr>> {
    list.split(',').map(str::trim).filter(|s| !s.is_empty()).map(Cidr::parse).collect()
}

// ------------------------------------------------------------------------------------------------ config

#[derive(Clone, Debug)]
pub struct SecurityCfg {
    /// Extra allowed CORS origins (exact match, e.g. `https://app.example.com`), or `*`. Localhost origins are always
    /// allowed. Empty = localhost only.
    pub cors_origins: Vec<String>,
    /// Peers allowed to set `X-Forwarded-For`. Empty = the header is never trusted.
    pub trusted_proxies: Vec<Cidr>,
    /// Reject `/v1` requests without a valid API key.
    pub require_api_key: bool,
    /// Per-IP token bucket for requests without an API key (rps 0 disables).
    pub ip_rps: f64,
    pub ip_burst: f64,
    /// Default per-key bucket (a key can override it).
    pub key_rps: f64,
    pub key_burst: f64,
}

impl Default for SecurityCfg {
    fn default() -> Self {
        Self {
            cors_origins: vec![],
            trusted_proxies: vec![],
            require_api_key: false,
            ip_rps: 50.0,
            ip_burst: 100.0,
            key_rps: 200.0,
            key_burst: 400.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct KeyInfo {
    pub id: String,
    pub label: String,
    pub rps: f64,
    pub burst: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Invalid,
}

struct KeyEntry {
    hash: String,
    info: KeyInfo,
}

pub struct Security {
    pub cfg: SecurityCfg,
    pub ip_limiter: Limiter,
    pub key_limiter: Limiter,
    keys: RwLock<HashMap<String, KeyEntry>>,
    store: Option<Arc<dyn EventStore>>,
}

impl Security {
    pub fn new(cfg: SecurityCfg, store: Option<Arc<dyn EventStore>>, ip_limiter: Limiter, key_limiter: Limiter) -> Self {
        Self {
            cfg,
            ip_limiter,
            key_limiter,
            keys: RwLock::new(HashMap::new()),
            store,
        }
    }

    /// In-memory limiters, no store: what the unit tests (and a Redis-less single process) use.
    pub fn local(cfg: SecurityCfg) -> Self {
        Self::new(cfg, None, Limiter::local("ip"), Limiter::local("key"))
    }

    // ---- CORS

    pub fn cors_allows(&self, origin: &str) -> bool {
        self.cfg.cors_origins.iter().any(|o| o == "*" || o == origin) || is_localhost_origin(origin)
    }

    /// Value of `Access-Control-Allow-Origin` for this request origin, or None (no CORS headers).
    pub fn cors_header(&self, origin: &str) -> Option<String> {
        if self.cfg.cors_origins.iter().any(|o| o == "*") {
            return Some("*".into());
        }
        self.cors_allows(origin).then(|| origin.to_string())
    }

    // ---- client IP

    /// Effective client IP: the socket peer, unless the peer is a trusted proxy, in which case the right-most
    /// `X-Forwarded-For` entry that is not itself a trusted proxy (a client cannot spoof entries to the right of the
    /// first untrusted hop).
    pub fn client_ip(&self, peer: IpAddr, xff: Option<&str>) -> IpAddr {
        let trusted = |ip: IpAddr| self.cfg.trusted_proxies.iter().any(|c| c.contains(ip));
        if !trusted(peer) {
            return peer;
        }
        let Some(h) = xff else { return peer };
        for part in h.rsplit(',') {
            match part.trim().parse::<IpAddr>() {
                Ok(ip) if trusted(ip) => continue,
                Ok(ip) => return ip,
                Err(_) => return peer, // malformed chain: do not guess
            }
        }
        peer
    }

    // ---- API keys

    /// Reload the key table from the store (cheap; called periodically so revocations take effect).
    pub async fn refresh_keys(&self) -> anyhow::Result<usize> {
        let Some(store) = &self.store else { return Ok(0) };
        let recs = store.list_api_keys().await?;
        let mut m = HashMap::new();
        for r in recs.into_iter().filter(|r| r.revoked_at.is_none()) {
            let info = KeyInfo {
                id: r.id.clone(),
                label: r.label,
                rps: r.rps.unwrap_or(self.cfg.key_rps),
                burst: r.burst.unwrap_or(self.cfg.key_burst),
            };
            m.insert(r.id, KeyEntry { hash: r.hash, info });
        }
        let n = m.len();
        *self.keys.write().unwrap() = m;
        Ok(n)
    }

    /// Install a key table directly (tests / no store).
    pub fn set_keys(&self, recs: Vec<ApiKeyRec>) {
        let m = recs
            .into_iter()
            .filter(|r| r.revoked_at.is_none())
            .map(|r| {
                let info = KeyInfo {
                    id: r.id.clone(),
                    label: r.label,
                    rps: r.rps.unwrap_or(self.cfg.key_rps),
                    burst: r.burst.unwrap_or(self.cfg.key_burst),
                };
                (r.id, KeyEntry { hash: r.hash, info })
            })
            .collect();
        *self.keys.write().unwrap() = m;
    }

    pub fn authenticate(&self, presented: &str) -> Result<KeyInfo, AuthError> {
        let (id, _) = parse_key(presented).ok_or(AuthError::Invalid)?;
        let g = self.keys.read().unwrap();
        let e = g.get(id).ok_or(AuthError::Invalid)?;
        if ct_eq(e.hash.as_bytes(), hash_key(presented).as_bytes()) {
            Ok(e.info.clone())
        } else {
            Err(AuthError::Invalid)
        }
    }
}

fn is_localhost_origin(o: &str) -> bool {
    let rest = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://"));
    let Some(host) = rest else { return false };
    let host = host.trim_end_matches('/');
    for h in ["localhost", "127.0.0.1", "[::1]"] {
        if host == h {
            return true;
        }
        if let Some(port) = host.strip_prefix(h).and_then(|r| r.strip_prefix(':')) {
            return !port.is_empty() && port.chars().all(|c| c.is_ascii_digit());
        }
    }
    false
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Key format: `pk_<id>_<secret>`; only keccak256(full key) is stored.
pub fn parse_key(k: &str) -> Option<(&str, &str)> {
    let rest = k.strip_prefix("pk_")?;
    let (id, secret) = rest.split_once('_')?;
    (id.len() == 8 && !secret.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit())).then_some((id, secret))
}

pub fn hash_key(full: &str) -> String {
    keccak256(full.as_bytes()).to_string()
}

fn random_hex(n: usize) -> anyhow::Result<String> {
    use std::io::Read;
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Create a fresh key. Returns the record to store (hash only) and the plaintext key, shown to the operator once.
pub fn generate_key(label: &str, rps: Option<f64>, burst: Option<f64>, now: i64) -> anyhow::Result<(ApiKeyRec, String)> {
    let id = random_hex(4)?;
    let secret = random_hex(24)?;
    let full = format!("pk_{id}_{secret}");
    Ok((
        ApiKeyRec {
            id,
            hash: hash_key(&full),
            label: label.to_string(),
            rps,
            burst,
            created_at: now,
            revoked_at: None,
        },
        full,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_matching() {
        let c = Cidr::parse("10.0.0.0/8").unwrap();
        assert!(c.contains("10.1.2.3".parse().unwrap()));
        assert!(!c.contains("11.0.0.1".parse().unwrap()));
        assert!(Cidr::parse("127.0.0.1").unwrap().contains("127.0.0.1".parse().unwrap()));
        assert!(!Cidr::parse("127.0.0.1").unwrap().contains("127.0.0.2".parse().unwrap()));
        assert!(Cidr::parse("fd00::/8").unwrap().contains("fd12::1".parse().unwrap()));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains("8.8.8.8".parse().unwrap()));
        assert!(Cidr::parse("10.0.0.0/33").is_err());
        assert!(Cidr::parse("nope").is_err());
        assert!(Cidr::parse("::ffff:10.0.0.1/128").unwrap().contains("10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn localhost_origin_detection() {
        for ok in ["http://localhost", "http://localhost:3000", "https://127.0.0.1:8443", "http://[::1]:80"] {
            assert!(is_localhost_origin(ok), "{ok}");
        }
        for bad in [
            "http://localhost.evil.com",
            "http://evil.com",
            "http://localhost:abc",
            "ftp://localhost",
            "http://127.0.0.1.evil.com",
            "null",
        ] {
            assert!(!is_localhost_origin(bad), "{bad}");
        }
    }
}
