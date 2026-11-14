//! Pure helpers for transaction submission: gas headroom, fee bumping, nonce-error detection.

/// gas limit = estimate * (100 + buffer_pct) / 100, saturating.
pub fn gas_with_buffer(estimate: u64, buffer_pct: u64) -> u64 {
    ((estimate as u128) * (100 + buffer_pct as u128) / 100).min(u64::MAX as u128) as u64
}

/// Replacement-fee bump: at least +1 wei and at least `pct` percent (callers enforce pct >= 12 so nodes' 10% rule holds).
pub fn bump_fee(fee: u128, pct: u64) -> u128 {
    let b = fee.saturating_mul(100 + pct as u128) / 100;
    b.max(fee.saturating_add(1))
}

/// Fee for attempt `n` (0 = first send), compounding the bump, clamped to `cap`. `None` when even the first fee exceeds the cap.
pub fn fee_for_attempt(base: u128, pct: u64, attempt: u32, cap: u128) -> Option<u128> {
    if base > cap {
        return None;
    }
    let mut f = base;
    for _ in 0..attempt {
        f = bump_fee(f, pct).min(cap);
    }
    Some(f)
}

/// True when a node error message indicates our locally tracked nonce is out of sync.
pub fn is_nonce_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("nonce too low") || m.contains("nonce is too low") || m.contains("nonce too high") || m.contains("invalid nonce")
        || m.contains("replacement transaction underpriced") || m.contains("already known")
}

/// What to do about a failed send, given the node's error text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendAction {
    /// Nonce/replacement race against our own earlier attempt: look at the receipts of what we already sent.
    CheckReceipts,
    /// Local nonce cache is stale: re-read the node's pending count and retry once.
    ResyncAndRetry,
    /// Stale nonce again after a resync: give up (cache is dropped so the next action re-reads it).
    ResyncAndFail,
    /// Not a nonce problem: surface the error.
    Fail,
}

pub fn send_error_action(msg: &str, have_sent_hashes: bool, resyncs_done: u32) -> SendAction {
    if !is_nonce_error(msg) {
        SendAction::Fail
    } else if have_sent_hashes {
        SendAction::CheckReceipts
    } else if resyncs_done < 1 {
        SendAction::ResyncAndRetry
    } else {
        SendAction::ResyncAndFail
    }
}

pub fn gwei_to_wei(g: u64) -> u128 {
    g as u128 * 1_000_000_000
}

/// Local nonce tracker. `next()` hands out sequential nonces; `resync` invalidates the cache so the next
/// call re-reads the node's pending count.
#[derive(Debug, Default)]
pub struct NonceTracker {
    next: Option<u64>,
}

impl NonceTracker {
    pub fn peek(&self) -> Option<u64> { self.next }
    pub fn set_from_chain(&mut self, n: u64) { self.next = Some(n); }
    pub fn consume(&mut self) { if let Some(n) = self.next.as_mut() { *n += 1; } }
    pub fn resync(&mut self) { self.next = None; }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gas_buffer() {
        assert_eq!(gas_with_buffer(100_000, 25), 125_000);
        assert_eq!(gas_with_buffer(u64::MAX, 50), u64::MAX);
    }

    #[test]
    fn bump_is_at_least_pct_and_strictly_increasing() {
        assert_eq!(bump_fee(1000, 15), 1150);
        assert_eq!(bump_fee(1, 15), 2);
        assert_eq!(bump_fee(0, 15), 1);
    }

    #[test]
    fn attempts_compound_and_cap() {
        assert_eq!(fee_for_attempt(1000, 20, 0, 10_000), Some(1000));
        assert_eq!(fee_for_attempt(1000, 20, 2, 10_000), Some(1440));
        assert_eq!(fee_for_attempt(1000, 20, 50, 5000), Some(5000));
        assert_eq!(fee_for_attempt(6000, 20, 0, 5000), None);
    }

    #[test]
    fn nonce_error_detection() {
        assert!(is_nonce_error("Nonce too low. Expected nonce to be 5"));
        assert!(is_nonce_error("replacement transaction underpriced"));
        assert!(!is_nonce_error("execution reverted"));
    }

    #[test]
    fn send_error_policy() {
        use SendAction::*;
        assert_eq!(send_error_action("execution reverted", false, 0), Fail);
        assert_eq!(send_error_action("nonce too low", false, 0), ResyncAndRetry);
        assert_eq!(send_error_action("nonce too low", false, 1), ResyncAndFail);
        assert_eq!(send_error_action("replacement transaction underpriced", true, 1), CheckReceipts);
        assert_eq!(send_error_action("insufficient funds", true, 0), Fail);
    }

    #[test]
    fn nonce_tracker() {
        let mut t = NonceTracker::default();
        assert_eq!(t.peek(), None);
        t.consume(); // no-op while unknown
        t.set_from_chain(7);
        t.consume();
        assert_eq!(t.peek(), Some(8));
        t.resync();
        assert_eq!(t.peek(), None);
    }
}
