//! Persistent keeper state (checkpoint) and the pure event-application logic.
use alloy::primitives::B256;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub const STATE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct AcctMeta {
    /// Needs a position refresh (new, or touched by a Fill since the last check).
    pub dirty: bool,
    /// Markets in which the account held a non-zero position at the last refresh.
    pub open: Vec<u8>,
    /// The account was touched since the last write-off check (flat accounts can only turn negative when touched).
    #[serde(default)]
    pub check_writeoff: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CondRec {
    pub market: u8,
    pub above: bool,
    pub trigger: u64,
}

/// How to undo one applied event if its block is reorged out.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum Undo {
    /// The event created this account: forget it.
    RemoveAccount(B256),
    /// Restore the conditional record to this previous value (None = was absent).
    RestoreCond(u64, Option<CondRec>),
    /// Restore the TWAP id's presence.
    RestoreTwap(u64, bool),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub version: u32,
    pub exchange: String,
    /// Next block to scan (everything below has been applied).
    pub next_block: u64,
    pub accounts: BTreeMap<B256, AcctMeta>,
    pub conds: BTreeMap<u64, CondRec>,
    pub twaps: BTreeSet<u64>,
    /// Hashes of the most recent scanned blocks (hash-chain reorg detection). Old checkpoints without it load fine
    /// (nothing to verify until new blocks are scanned).
    #[serde(default)]
    pub hashes: BTreeMap<u64, B256>,
    /// Undo journal for events applied in the recent block window, in application order: `(block, undo)`.
    #[serde(default)]
    pub journal: Vec<(u64, Undo)>,
    /// Pyth pusher bookkeeping (spend ledger, backoff, schedule). Old checkpoints load with the default.
    #[serde(default)]
    pub pyth: crate::features::pyth_push::PythPersist,
}

/// Decoded, chain-agnostic events the keeper cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Deposit { acct: B256 },
    Fill { maker: B256, taker: B256 },
    CondPlaced { id: u64, market: u8, above: bool, trigger: u64 },
    CondGone { id: u64 },
    TwapPlaced { id: u64 },
    TwapGone { id: u64 },
}

impl State {
    pub fn new(exchange: String, start_block: u64) -> State {
        State { version: STATE_VERSION, exchange, next_block: start_block, accounts: BTreeMap::new(), conds: BTreeMap::new(), twaps: BTreeSet::new(), hashes: BTreeMap::new(), journal: vec![], pyth: Default::default() }
    }

    /// Apply an event that was emitted in `block`, recording how to undo it.
    pub fn apply_at(&mut self, block: u64, ev: &Event, backstop: &B256) {
        let undo = self.apply(ev, backstop);
        self.journal.extend(undo.into_iter().map(|u| (block, u)));
    }

    /// Roll everything applied after `ancestor` (a block that is still canonical) back and move the scan cursor to
    /// `ancestor + 1`. Every tracked account is re-marked dirty because positions may have changed under it.
    pub fn rollback_to(&mut self, ancestor: u64) {
        while let Some((b, _)) = self.journal.last() {
            if *b <= ancestor {
                break;
            }
            let (_, u) = self.journal.pop().expect("non-empty");
            match u {
                Undo::RemoveAccount(a) => {
                    self.accounts.remove(&a);
                }
                Undo::RestoreCond(id, Some(r)) => {
                    self.conds.insert(id, r);
                }
                Undo::RestoreCond(id, None) => {
                    self.conds.remove(&id);
                }
                Undo::RestoreTwap(id, true) => {
                    self.twaps.insert(id);
                }
                Undo::RestoreTwap(id, false) => {
                    self.twaps.remove(&id);
                }
            }
        }
        self.hashes.retain(|n, _| *n <= ancestor);
        self.next_block = ancestor + 1;
        for m in self.accounts.values_mut() {
            m.dirty = true;
            m.check_writeoff = true;
        }
    }

    /// Drop hashes/journal older than `keep_from` (they can no longer be rolled back anyway).
    pub fn prune(&mut self, keep_from: u64) {
        self.hashes.retain(|n, _| *n >= keep_from);
        self.journal.retain(|(b, _)| *b >= keep_from);
    }

    /// Apply one event and return how to undo it. `backstop` is never tracked as a liquidation candidate.
    pub fn apply(&mut self, ev: &Event, backstop: &B256) -> Vec<Undo> {
        match ev {
            Event::Deposit { acct } => self.touch(acct, backstop).into_iter().collect(),
            Event::Fill { maker, taker } => {
                let mut u: Vec<Undo> = self.touch(maker, backstop).into_iter().collect();
                u.extend(self.touch(taker, backstop));
                u
            }
            Event::CondPlaced { id, market, above, trigger } => {
                let prev = self.conds.insert(*id, CondRec { market: *market, above: *above, trigger: *trigger });
                vec![Undo::RestoreCond(*id, prev)]
            }
            Event::CondGone { id } => {
                let prev = self.conds.remove(id);
                vec![Undo::RestoreCond(*id, prev)]
            }
            Event::TwapPlaced { id } => vec![Undo::RestoreTwap(*id, !self.twaps.insert(*id))],
            Event::TwapGone { id } => vec![Undo::RestoreTwap(*id, self.twaps.remove(id))],
        }
    }

    fn touch(&mut self, a: &B256, backstop: &B256) -> Option<Undo> {
        if a == backstop {
            return None;
        }
        let new = !self.accounts.contains_key(a);
        { let m = self.accounts.entry(*a).or_default(); m.dirty = true; m.check_writeoff = true; }
        new.then_some(Undo::RemoveAccount(*a))
    }

    /// Accounts that need work this tick: dirty ones and ones with open positions.
    pub fn active_accounts(&self) -> Vec<B256> {
        self.accounts.iter().filter(|(_, m)| m.dirty || !m.open.is_empty()).map(|(k, _)| *k).collect()
    }

    /// Accounts whose flat buckets still have to be checked for a negative balance.
    pub fn writeoff_pending(&self) -> Vec<B256> {
        self.accounts.iter().filter(|(_, m)| m.check_writeoff).map(|(k, _)| *k).collect()
    }

    pub fn accounts_with_positions(&self) -> usize {
        self.accounts.values().filter(|m| !m.open.is_empty()).count()
    }

    /// Atomic write (tmp + rename) so a crash never leaves a torn checkpoint.
    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("tmp");
        let json = serde_json::to_vec_pretty(self)?;
        std::fs::write(&tmp, json).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
        Ok(())
    }

    /// Load a checkpoint. Returns `None` when the file is missing, unreadable, from another version, or for a different exchange.
    pub fn load(path: &Path, exchange: &str) -> Option<State> {
        let bytes = std::fs::read(path).ok()?;
        let s: State = serde_json::from_slice(&bytes).ok()?;
        (s.version == STATE_VERSION && s.exchange.eq_ignore_ascii_case(exchange)).then_some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(n: u8) -> B256 { B256::repeat_byte(n) }

    #[test]
    fn deposit_and_fill_discover_accounts_but_skip_backstop() {
        let mut s = State::new("0xabc".into(), 0);
        let back = k(0xff);
        s.apply(&Event::Deposit { acct: k(1) }, &back);
        s.apply(&Event::Fill { maker: k(2), taker: back }, &back);
        assert_eq!(s.accounts.len(), 2);
        assert!(!s.accounts.contains_key(&back));
        assert!(s.accounts[&k(1)].dirty);
        assert_eq!(s.writeoff_pending().len(), 2, "touched accounts are queued for a write-off check");
    }

    #[test]
    fn active_accounts_filters_idle() {
        let mut s = State::new("0xabc".into(), 0);
        let back = k(0xff);
        s.apply(&Event::Deposit { acct: k(1) }, &back);
        s.accounts.get_mut(&k(1)).unwrap().dirty = false;
        assert!(s.active_accounts().is_empty());
        s.accounts.get_mut(&k(1)).unwrap().open = vec![0];
        assert_eq!(s.active_accounts(), vec![k(1)]);
        assert_eq!(s.accounts_with_positions(), 1);
    }

    #[test]
    fn cond_and_twap_lifecycle() {
        let mut s = State::new("0xabc".into(), 0);
        let b = k(0xff);
        s.apply(&Event::CondPlaced { id: 5, market: 1, above: true, trigger: 99 }, &b);
        s.apply(&Event::TwapPlaced { id: 3 }, &b);
        assert_eq!(s.conds[&5], CondRec { market: 1, above: true, trigger: 99 });
        assert!(s.twaps.contains(&3));
        s.apply(&Event::CondGone { id: 5 }, &b);
        s.apply(&Event::TwapGone { id: 3 }, &b);
        assert!(s.conds.is_empty() && s.twaps.is_empty());
        // removing something unknown is a no-op
        s.apply(&Event::CondGone { id: 77 }, &b);
    }

    #[test]
    fn rollback_undoes_events_after_ancestor_only() {
        let mut s = State::new("0xabc".into(), 0);
        let b = k(0xff);
        s.apply_at(5, &Event::Deposit { acct: k(1) }, &b);
        s.apply_at(5, &Event::CondPlaced { id: 1, market: 0, above: true, trigger: 10 }, &b);
        s.apply_at(5, &Event::TwapPlaced { id: 7 }, &b);
        let before = (s.accounts.clone(), s.conds.clone(), s.twaps.clone());
        // block 8: new account, cond replaced + removed, twap removed, a second twap added
        s.apply_at(8, &Event::Deposit { acct: k(2) }, &b);
        s.apply_at(8, &Event::Deposit { acct: k(1) }, &b);
        s.apply_at(8, &Event::CondPlaced { id: 1, market: 3, above: false, trigger: 99 }, &b);
        s.apply_at(9, &Event::CondGone { id: 1 }, &b);
        s.apply_at(9, &Event::TwapGone { id: 7 }, &b);
        s.apply_at(9, &Event::TwapPlaced { id: 8 }, &b);
        s.next_block = 10;
        s.hashes.insert(5, k(5));
        s.hashes.insert(9, k(9));
        s.accounts.get_mut(&k(1)).unwrap().dirty = false;
        s.rollback_to(5);
        assert_eq!((s.accounts.clone(), s.conds.clone(), s.twaps.clone()).1, before.1);
        assert_eq!(s.twaps, before.2);
        assert!(!s.accounts.contains_key(&k(2)) && s.accounts.contains_key(&k(1)));
        assert!(s.accounts[&k(1)].dirty, "accounts re-marked dirty after a rollback");
        assert_eq!(s.next_block, 6);
        assert_eq!(s.hashes.keys().copied().collect::<Vec<_>>(), vec![5]);
        assert!(s.journal.iter().all(|(b, _)| *b <= 5));
    }

    #[test]
    fn prune_drops_old_entries() {
        let mut s = State::new("0xabc".into(), 0);
        s.apply_at(1, &Event::Deposit { acct: k(1) }, &k(0xff));
        s.apply_at(9, &Event::Deposit { acct: k(2) }, &k(0xff));
        s.hashes.insert(1, k(1));
        s.hashes.insert(9, k(9));
        s.prune(5);
        assert_eq!(s.hashes.len(), 1);
        assert_eq!(s.journal.len(), 1);
    }

    #[test]
    fn old_checkpoint_without_reorg_fields_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("old.json");
        std::fs::write(&p, r#"{"version":1,"exchange":"0xabc","next_block":7,"accounts":{},"conds":{},"twaps":[]}"#).unwrap();
        let s = State::load(&p, "0xabc").unwrap();
        assert_eq!(s.next_block, 7);
        assert!(s.hashes.is_empty() && s.journal.is_empty());
    }

    #[test]
    fn roundtrip_and_rejects_foreign_state() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.json");
        let mut s = State::new("0xAbC".into(), 42);
        s.apply(&Event::Deposit { acct: k(9) }, &k(0xff));
        s.apply(&Event::CondPlaced { id: 1, market: 0, above: false, trigger: 5 }, &k(0xff));
        s.save(&p).unwrap();
        let back = State::load(&p, "0xabc").unwrap();
        assert_eq!(back, s);
        assert!(State::load(&p, "0xdef").is_none());
        assert!(State::load(&dir.path().join("missing.json"), "0xabc").is_none());
        std::fs::write(&p, b"not json").unwrap();
        assert!(State::load(&p, "0xabc").is_none());
    }
}
