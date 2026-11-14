//! Websocket fan-out hub with bounded per-client queues.
//!
//! Every client owns a bounded `mpsc` queue. The publisher never blocks: if `try_send` finds the queue full the
//! client is a slow consumer, is removed and flagged, and its writer task closes the socket with code 4008.
//!
//! Locking order (avoid deadlock): `Shared.state` first, then `Hub.inner`.

use crate::state::{Interval, Out, State};
use alloy_primitives::B256;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

pub const CLOSE_SLOW_CONSUMER: u16 = 4008;
pub const CLOSE_PROTOCOL: u16 = 4000;
pub const MAX_SUBS_PER_CLIENT: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Sub {
    Book(u8),
    Trades(u8),
    Candles(u8, Interval),
    Orders(B256),
    Fills(B256),
}

struct ClientEntry {
    tx: mpsc::Sender<Arc<str>>,
    subs: HashSet<Sub>,
    slow: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    clients: HashMap<u64, ClientEntry>,
}

pub struct Hub {
    cap: usize,
    inner: Mutex<Inner>,
    pub dropped_slow: AtomicU64,
}

pub struct ClientHandle {
    pub id: u64,
    pub rx: mpsc::Receiver<Arc<str>>,
    pub slow: Arc<AtomicBool>,
}

impl Hub {
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            inner: Mutex::new(Inner::default()),
            dropped_slow: AtomicU64::new(0),
        }
    }

    pub fn register(&self) -> ClientHandle {
        let (tx, rx) = mpsc::channel(self.cap);
        let slow = Arc::new(AtomicBool::new(false));
        let mut g = self.inner.lock().unwrap();
        g.next_id += 1;
        let id = g.next_id;
        g.clients.insert(
            id,
            ClientEntry {
                tx,
                subs: HashSet::new(),
                slow: slow.clone(),
            },
        );
        ClientHandle { id, rx, slow }
    }

    pub fn unregister(&self, id: u64) {
        self.inner.lock().unwrap().clients.remove(&id);
    }

    pub fn client_count(&self) -> usize {
        self.inner.lock().unwrap().clients.len()
    }

    fn drop_slow(&self, g: &mut Inner, id: u64) {
        if let Some(c) = g.clients.remove(&id) {
            c.slow.store(true, Ordering::SeqCst);
            self.dropped_slow.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(client = id, "dropping slow websocket consumer (queue full)");
        }
    }

    /// Add a subscription and (atomically, under the hub lock) enqueue `initial` (e.g. a book snapshot).
    /// Callers snapshotting state must hold the state read lock across this call so no delta is missed or duplicated.
    pub fn subscribe(&self, id: u64, sub: Sub, initial: Option<String>) -> Result<(), &'static str> {
        let mut g = self.inner.lock().unwrap();
        let mut slow = false;
        match g.clients.get_mut(&id) {
            None => return Err("gone"),
            Some(c) => {
                if !c.subs.contains(&sub) && c.subs.len() >= MAX_SUBS_PER_CLIENT {
                    return Err("too_many_subscriptions");
                }
                c.subs.insert(sub);
                if let Some(m) = initial {
                    if let Err(TrySendError::Full(_)) = c.tx.try_send(m.into()) {
                        slow = true;
                    }
                }
            }
        }
        if slow {
            self.drop_slow(&mut g, id);
        }
        Ok(())
    }

    pub fn unsubscribe(&self, id: u64, sub: &Sub) {
        if let Some(c) = self.inner.lock().unwrap().clients.get_mut(&id) {
            c.subs.remove(sub);
        }
    }

    /// Reply to one client (ack / error / pong). Treated like any other message for backpressure.
    pub fn send_direct(&self, id: u64, msg: String) {
        let mut g = self.inner.lock().unwrap();
        let mut slow = false;
        if let Some(c) = g.clients.get(&id) {
            if let Err(TrySendError::Full(_)) = c.tx.try_send(msg.into()) {
                slow = true;
            }
        }
        if slow {
            self.drop_slow(&mut g, id);
        }
    }

    fn fan(&self, g: &mut Inner, key: &Sub, msg: &Arc<str>, dead: &mut Vec<(u64, bool)>) {
        for (id, c) in g.clients.iter() {
            if c.subs.contains(key) {
                match c.tx.try_send(msg.clone()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => dead.push((*id, true)),
                    Err(TrySendError::Closed(_)) => dead.push((*id, false)),
                }
            }
        }
    }

    /// Fan out the side-effects of applied events. Never blocks.
    pub fn publish(&self, outs: &[Out]) {
        if outs.is_empty() {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        if g.clients.is_empty() {
            return;
        }
        let mut dead = Vec::new();
        for o in outs {
            match o {
                Out::Book(d) => {
                    let m: Arc<str> = json!({"type":"delta","channel":"book","market":d.market,"seq":d.seq,"side":d.side,"price":d.price.to_string(),"size":d.size.to_string()}).to_string().into();
                    self.fan(&mut g, &Sub::Book(d.market), &m, &mut dead);
                }
                Out::Trade(f) => {
                    let data = serde_json::to_value(f).unwrap_or(Value::Null);
                    let m: Arc<str> = json!({"type":"trade","channel":"trades","market":f.market,"data":data}).to_string().into();
                    self.fan(&mut g, &Sub::Trades(f.market), &m, &mut dead);
                    let mk: Arc<str> = json!({"type":"fill","channel":"fills","acct":f.maker,"role":"maker","data":data})
                        .to_string()
                        .into();
                    self.fan(&mut g, &Sub::Fills(f.maker), &mk, &mut dead);
                    if f.taker != f.maker {
                        let tk: Arc<str> = json!({"type":"fill","channel":"fills","acct":f.taker,"role":"taker","data":data})
                            .to_string()
                            .into();
                        self.fan(&mut g, &Sub::Fills(f.taker), &tk, &mut dead);
                    }
                }
                Out::Candle { market, interval, candle } => {
                    let m: Arc<str> = json!({"type":"candle","channel":"candles","market":market,"interval":interval.name(),"data":candle})
                        .to_string()
                        .into();
                    self.fan(&mut g, &Sub::Candles(*market, *interval), &m, &mut dead);
                }
                Out::Order(r) => {
                    let m: Arc<str> = json!({"type":"order","channel":"orders","acct":r.acct,"data":r}).to_string().into();
                    self.fan(&mut g, &Sub::Orders(r.acct), &m, &mut dead);
                }
            }
        }
        dead.sort();
        dead.dedup();
        for (id, slow) in dead {
            if slow {
                self.drop_slow(&mut g, id);
            } else {
                g.clients.remove(&id);
            }
        }
    }

    /// After a reorg rollback the per-market sequence numbers restart from the replayed log: tell every client to
    /// discard local state and send fresh book snapshots.
    pub fn resync_all(&self, st: &State, fork_block: u64) {
        let mut g = self.inner.lock().unwrap();
        let mut dead = Vec::new();
        for (id, c) in g.clients.iter() {
            let mut msgs: Vec<String> = vec![json!({"type":"resync","reason":"reorg","fork_block":fork_block}).to_string()];
            for s in &c.subs {
                if let Sub::Book(m) = s {
                    msgs.push(book_snapshot_msg(st, *m));
                }
            }
            for m in msgs {
                if let Err(TrySendError::Full(_)) = c.tx.try_send(m.into()) {
                    dead.push(*id);
                    break;
                }
            }
        }
        for id in dead {
            self.drop_slow(&mut g, id);
        }
    }
}

pub fn book_snapshot_msg(st: &State, market: u8) -> String {
    let (seq, bids, asks) = st.book_snapshot(market, usize::MAX);
    let lv = |v: Vec<(u64, u128)>| -> Vec<Value> { v.into_iter().map(|(p, s)| json!([p.to_string(), s.to_string()])).collect() };
    json!({"type":"snapshot","channel":"book","market":market,"seq":seq,"bids":lv(bids),"asks":lv(asks)}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::BookDelta;

    fn delta(seq: u64) -> Out {
        Out::Book(BookDelta {
            market: 0,
            seq,
            side: "bid",
            price: 1,
            size: 1,
        })
    }

    #[tokio::test]
    async fn slow_consumer_is_dropped_and_flagged() {
        let hub = Hub::new(2);
        let mut slow = hub.register();
        let mut fast = hub.register();
        hub.subscribe(slow.id, Sub::Book(0), None).unwrap();
        hub.subscribe(fast.id, Sub::Book(0), None).unwrap();
        for s in 1..=3 {
            hub.publish(&[delta(s)]);
            // fast client keeps draining
            let _ = fast.rx.recv().await.unwrap();
        }
        assert!(slow.slow.load(Ordering::SeqCst), "slow client must be flagged");
        assert_eq!(hub.client_count(), 1, "slow client removed, fast client kept");
        // the slow client can still drain what was queued, then sees the channel close
        assert!(slow.rx.recv().await.is_some());
        assert!(slow.rx.recv().await.is_some());
        assert!(slow.rx.recv().await.is_none());
        assert_eq!(hub.dropped_slow.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn only_subscribed_channels_receive() {
        let hub = Hub::new(8);
        let mut a = hub.register();
        let mut b = hub.register();
        hub.subscribe(a.id, Sub::Book(0), None).unwrap();
        hub.subscribe(b.id, Sub::Book(1), None).unwrap();
        hub.publish(&[delta(1)]);
        assert!(a.rx.try_recv().is_ok());
        assert!(b.rx.try_recv().is_err());
    }
}
