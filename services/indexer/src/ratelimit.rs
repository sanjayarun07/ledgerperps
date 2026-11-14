//! Token-bucket rate limiting: an in-memory limiter, and an optional Redis-backed shared limiter (`REDIS_URL`) so
//! several API replicas enforce one budget. If Redis is configured but unreachable the in-memory bucket is used
//! (fail-open to a per-process limit; `rate_backend_errors` counts the fallbacks).
use crate::redis::RedisClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct RateLimiter {
    rate: f64,
    burst: f64,
    buckets: Mutex<HashMap<String, (f64, Instant)>>,
}

impl RateLimiter {
    pub fn new(rate_per_sec: f64, burst: f64) -> Self {
        Self {
            rate: rate_per_sec,
            burst: burst.max(1.0),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Ok(()) if a token was taken, else Err(seconds until one token is available). Uses the limiter's own rate.
    pub fn check(&self, key: &str) -> Result<(), u64> {
        self.check_with(key, self.rate, self.burst, Instant::now())
    }

    pub fn check_at(&self, key: &str, now: Instant) -> Result<(), u64> {
        self.check_with(key, self.rate, self.burst, now)
    }

    /// Take a token from `key`'s bucket using an explicit `rate`/`burst` (per-API-key overrides).
    pub fn check_with(&self, key: &str, rate: f64, burst: f64, now: Instant) -> Result<(), u64> {
        if rate <= 0.0 {
            return Ok(()); // disabled
        }
        let burst = burst.max(1.0);
        let mut g = self.buckets.lock().unwrap();
        if g.len() > 50_000 {
            // bound memory: forget buckets that have fully refilled
            g.retain(|_, (t, at)| *t + now.saturating_duration_since(*at).as_secs_f64() * rate < burst);
        }
        let e = g.entry(key.to_string()).or_insert((burst, now));
        let elapsed = now.saturating_duration_since(e.1).as_secs_f64();
        e.0 = (e.0 + elapsed * rate).min(burst);
        e.1 = now;
        if e.0 >= 1.0 {
            e.0 -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - e.0) / rate).ceil().max(1.0) as u64)
        }
    }
}

/// In-memory limiter with an optional shared Redis backend.
pub struct Limiter {
    local: RateLimiter,
    redis: Option<Arc<RedisClient>>,
    prefix: String,
    pub backend_errors: AtomicU64,
}

impl Limiter {
    pub fn local(prefix: &str) -> Self {
        Self {
            local: RateLimiter::new(1.0, 1.0),
            redis: None,
            prefix: prefix.into(),
            backend_errors: AtomicU64::new(0),
        }
    }

    pub fn with_redis(prefix: &str, redis: Arc<RedisClient>) -> Self {
        Self {
            redis: Some(redis),
            ..Self::local(prefix)
        }
    }

    pub fn is_shared(&self) -> bool {
        self.redis.is_some()
    }

    /// Take one token for `key` (`rate` tokens/second, bucket size `burst`). Err = seconds to wait.
    pub async fn check(&self, key: &str, rate: f64, burst: f64) -> Result<(), u64> {
        if rate <= 0.0 {
            return Ok(());
        }
        if let Some(r) = &self.redis {
            match r.token_bucket(&format!("{}:{key}", self.prefix), rate, burst.max(1.0)).await {
                Ok(v) => return v,
                Err(e) => {
                    self.backend_errors.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(error = %format!("{e:#}"), "redis rate limiter unavailable; using the in-memory bucket");
                }
            }
        }
        self.local.check_with(key, rate, burst, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bucket_limits_refills_and_isolates_keys() {
        let rl = RateLimiter::new(2.0, 3.0);
        let (a, b) = ("ip:10.0.0.1", "ip:10.0.0.2");
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(rl.check_at(a, t0).is_ok());
        }
        assert!(rl.check_at(a, t0).is_err(), "burst exhausted");
        assert!(rl.check_at(b, t0).is_ok(), "other key unaffected");
        assert!(rl.check_at(a, t0 + Duration::from_millis(600)).is_ok(), "refilled 1.2 tokens");
        assert!(rl.check_at(a, t0 + Duration::from_millis(600)).is_err());
    }

    #[test]
    fn explicit_rate_overrides_default() {
        let rl = RateLimiter::new(1.0, 1.0);
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(rl.check_with("key:a", 100.0, 10.0, t0).is_ok());
        }
        assert!(rl.check_with("key:a", 100.0, 10.0, t0).is_err());
    }
}
