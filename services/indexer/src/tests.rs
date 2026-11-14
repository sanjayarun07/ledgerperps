//! Fixture-driven tests: status derivation, candles, positions, idempotent replay, reorg rollback, API, websocket.
//! No node and no database are needed; `MemStore` honours the same contract as `PgStore`.

use crate::api::{router, App};
use crate::events::*;
use crate::indexer::{ChainSource, Indexer, IndexerCfg};
use crate::security::{Security, SecurityCfg};
use crate::shared::Shared;
use crate::state::*;
use crate::store::{BlockRef, EventStore, MemStore};
use alloy_primitives::{keccak256, Address, B256};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const BTC: u128 = 100_000_000; // 1.0 base unit
const PX: u64 = 1_000_000; // $1

fn acct(n: u8) -> B256 {
    B256::repeat_byte(n)
}

// ------------------------------------------------------------------------------------------------ fixture builders

fn accepted(id: u64, a: u8, is_buy: bool, price: u64, size: u128, tif: u8) -> Ev {
    Ev::OrderAccepted {
        id,
        acct: acct(a),
        market: 0,
        is_buy,
        price,
        size,
        tif,
        reduce_only: false,
        cloid: 0,
    }
}
fn rested(id: u64, remaining: u128) -> Ev {
    Ev::OrderRested { id, remaining }
}
fn canceled(id: u64, reason: u8, remaining: u128) -> Ev {
    Ev::OrderCanceled { id, reason, remaining }
}
#[allow(clippy::too_many_arguments)]
fn fill(trade: u64, maker_order: u64, maker: u8, taker: u8, taker_is_buy: bool, price: u64, size: u128) -> Ev {
    Ev::Fill {
        trade_id: trade,
        market: 0,
        maker_order_id: maker_order,
        maker: acct(maker),
        taker: acct(taker),
        taker_is_buy,
        price,
        size,
        taker_fee: 10,
        maker_fee: -1,
    }
}

/// Builds the events of one block, one inner Vec per transaction.
fn mk_block(number: u64, parent: B256, salt: u8, ts: u64, txs: Vec<Vec<Ev>>) -> (BlockRef, Vec<EventRecord>) {
    let hash = keccak256([&number.to_be_bytes()[..], &[salt]].concat());
    let mut recs = Vec::new();
    let mut li = 0u32;
    for (t, evs) in txs.into_iter().enumerate() {
        let tx_hash = keccak256([&number.to_be_bytes()[..], &[salt, t as u8, 0xee]].concat());
        for ev in evs {
            recs.push(EventRecord {
                meta: Meta {
                    block: number,
                    log_index: li,
                    tx_hash,
                    block_hash: hash,
                    ts,
                },
                ev,
                raw: None,
            });
            li += 1;
        }
    }
    (
        BlockRef {
            number,
            hash,
            parent_hash: parent,
            ts,
        },
        recs,
    )
}

/// A scripted chain made of consecutive blocks starting at block 1 (block 0 is a genesis stub).
struct Script {
    blocks: Vec<(BlockRef, Vec<EventRecord>)>,
}
impl Script {
    fn new() -> Self {
        let (g, _) = mk_block(0, B256::ZERO, 0, 0, vec![]);
        Self { blocks: vec![(g, vec![])] }
    }
    fn push(&mut self, salt: u8, ts: u64, txs: Vec<Vec<Ev>>) -> &mut Self {
        let n = self.blocks.len() as u64;
        let parent = self.blocks.last().unwrap().0.hash;
        self.blocks.push(mk_block(n, parent, salt, ts, txs));
        self
    }
    fn all_events(&self) -> Vec<EventRecord> {
        self.blocks.iter().flat_map(|b| b.1.clone()).collect()
    }
}

/// The rich scenario used by most tests (see comments for the expected outcome of each order).
fn scenario() -> Script {
    let mut s = Script::new();
    // b1: A rests ask 1 BTC @50k (order 1)
    s.push(0, 1_000, vec![vec![accepted(1, 1, false, 50_000 * PX, BTC, 0), rested(1, BTC)]]);
    // b2: B IOC-buys 0.4 -> partial fill of order 1
    s.push(
        0,
        1_030,
        vec![vec![
            accepted(2, 2, true, 50_000 * PX, 2 * BTC / 5, 1),
            fill(0, 1, 1, 2, true, 50_000 * PX, 2 * BTC / 5),
        ]],
    );
    // b3 (next minute): C IOC-buys 0.6 -> fills the rest. Contract emits OrderCanceled(Filled) BEFORE the Fill.
    s.push(
        0,
        1_100,
        vec![vec![
            accepted(3, 3, true, 50_000 * PX, 3 * BTC / 5, 1),
            canceled(1, cancel::FILLED, 0),
            fill(1, 1, 1, 3, true, 50_000 * PX, 3 * BTC / 5),
        ]],
    );
    // b4: D rests bid 1 BTC @49k (order 4); E rests ask 0.5 @51k (order 5, will expire); F rests ask 0.5 @51.5k (order 6, rejected)
    s.push(
        0,
        1_130,
        vec![
            vec![accepted(4, 4, true, 49_000 * PX, BTC, 0), rested(4, BTC)],
            vec![accepted(5, 5, false, 51_000 * PX, BTC / 2, 0), rested(5, BTC / 2)],
            vec![accepted(6, 6, false, 51_500 * PX, BTC / 2, 0), rested(6, BTC / 2)],
        ],
    );
    // b5: G IOC sell 2 BTC @48k: fills D partially (0.25), then IOC remainder canceled.
    s.push(
        0,
        1_160,
        vec![vec![
            accepted(7, 7, false, 48_000 * PX, 2 * BTC, 1),
            fill(2, 4, 4, 7, false, 49_000 * PX, BTC / 4),
            canceled(7, cancel::USER, 2 * BTC - BTC / 4),
        ]],
    );
    // b6: a taker walks the 51k ask: order 5 expired, order 6 maker-margin rejected; taker H IOC buy finds nothing
    s.push(
        0,
        3_700,
        vec![vec![
            accepted(8, 8, true, 52_000 * PX, BTC, 1),
            canceled(5, cancel::EXPIRED, BTC / 2),
            canceled(6, cancel::MAKER_MARGIN, BTC / 2),
            canceled(8, cancel::USER, BTC),
        ]],
    );
    // b7: deposits / withdraw / funding / liquidation-free admin
    s.push(
        0,
        3_760,
        vec![vec![
            Ev::Deposit {
                acct: acct(1),
                from: Address::repeat_byte(0xaa),
                amount: 1_000_000_000,
            },
            Ev::Withdraw {
                acct: acct(1),
                amount: 5_000_000,
            },
            Ev::FundingUpdated {
                market: 0,
                intervals: 1,
                rate: 40_000_000,
                new_index: 20_000_000,
            },
            Ev::FundingSettled {
                acct: acct(3),
                market: 0,
                owed: 7,
            },
            Ev::MarketState { market: 0, state: 1 },
        ]],
    );
    s
}

fn apply_script(s: &Script) -> State {
    let mut st = State::new();
    st.apply_all(&s.all_events());
    st
}

// ------------------------------------------------------------------------------------------------ status derivation

#[test]
fn status_derivation_table() {
    use OrderStatus::*;
    let d = derive_status;
    assert_eq!(d(0, 10, false, None), Accepted);
    assert_eq!(d(0, 10, true, None), Open);
    assert_eq!(d(4, 10, true, None), PartiallyFilled);
    assert_eq!(d(10, 10, false, None), Filled); // taker fully filled, never rested
    assert_eq!(d(3, 10, false, Some(cancel::FILLED)), Filled); // Filled-cancel precedes the last Fill
    assert_eq!(d(0, 10, true, Some(cancel::USER)), Canceled);
    assert_eq!(d(0, 10, false, Some(cancel::USER)), Canceled); // IOC with no liquidity
    assert_eq!(d(4, 10, false, Some(cancel::USER)), Canceled); // IOC remainder after partial fill
    assert_eq!(d(0, 10, true, Some(cancel::REPLACED)), Canceled);
    assert_eq!(d(0, 10, true, Some(cancel::LIQUIDATION)), Canceled);
    assert_eq!(d(0, 10, true, Some(cancel::PRICE_BAND)), Canceled); // WASH-1: resting order outside index +/- bandBps
    assert_eq!(cancel::name(cancel::PRICE_BAND), "price_band");
    assert_eq!(d(0, 10, true, Some(cancel::EXPIRED)), Expired);
    assert_eq!(d(0, 10, true, Some(cancel::SELF_TRADE)), Rejected);
    assert_eq!(d(0, 10, true, Some(cancel::MAKER_MARGIN)), Rejected);
    assert_eq!(d(0, 10, true, Some(cancel::INVALID_REDUCE_ONLY)), Rejected);
    assert_eq!(d(2, 10, true, Some(cancel::MAKER_MARGIN)), Canceled); // had fills: not a pure rejection
}

#[test]
fn price_band_cancel_and_standalone_write_off_are_indexed() {
    // WASH-1: a resting order outside index +/- bandBps is cancelled with reason PriceBand (8) by someone else's tx.
    // LIQ-2/SETTLE-1/LEDGER-1: BadDebtUnresolved can come from a plain fill or the permissionless writeOff, not only liquidate.
    let mut s = Script::new();
    s.push(0, 10, vec![vec![accepted(1, 1, false, 50_000 * PX, BTC, 0), rested(1, BTC)]]);
    s.push(0, 20, vec![vec![canceled(1, 8, BTC)]]);
    s.push(0, 30, vec![vec![Ev::BadDebtUnresolved { acct: acct(3), amount: 7 }]]); // writeOff-style tx with no other events
    let st = apply_script(&s);
    let o = st.orders.get(&1).unwrap();
    assert_eq!(o.status, OrderStatus::Canceled);
    assert_eq!(o.cancel_reason, Some("price_band"));
    assert_eq!(o.cancel_code, Some(8));
    assert_eq!(st.bad_debt.len(), 1);
    assert_eq!(st.bad_debt[0].kind, "bad_debt_unresolved");
    assert_eq!(st.bad_debt[0].amount, 7);
    // the new label must survive a snapshot round trip (labels are interned from a static table)
    let back = State::from_snapshot(&st.to_snapshot(), &st).expect("snapshot with price_band restores");
    assert_eq!(back.orders.get(&1).unwrap().cancel_reason, Some("price_band"));
}

#[test]
fn backstop_adl_skip_and_gate_events_are_indexed_and_survive_snapshots() {
    let mut s = Script::new();
    s.push(0, 10, vec![vec![Ev::BadDebtUnresolved { acct: B256::repeat_byte(0xff), amount: 9 }]]); // BACKSTOP key via sync
    s.push(
        0,
        20,
        vec![vec![
            Ev::BackstopSynced { equity_before: -15, from_insurance: 6, to_debt: 9, market: 2, refunded_insurance: 0, repaid_debt: 0 },
            Ev::AdlSkipped { target: acct(4), market: 2, slack: 0 },
            Ev::AdlHardPremSet { bps: 2000 },
            Ev::WithdrawGateSet { threshold: u128::MAX },
        ]],
    );
    s.push(0, 30, vec![vec![Ev::BackstopSynced { equity_before: 7, from_insurance: 0, to_debt: 0, market: 0, refunded_insurance: 3, repaid_debt: 4 }]]);
    let st = apply_script(&s);
    assert_eq!(st.bad_debt.len(), 1);
    assert_eq!(st.bad_debt[0].acct, Some(B256::repeat_byte(0xff)));
    let kinds: Vec<_> = st.backstop.iter().map(|r| r.kind).collect();
    assert_eq!(kinds, vec!["backstop_synced", "adl_skipped", "adl_hard_prem_set", "withdraw_gate_set", "backstop_synced"]);
    assert_eq!(st.backstop[0].market, Some(2));
    assert_eq!(st.backstop[0].equity_before.as_deref(), Some("-15"));
    assert_eq!(st.backstop[0].to_debt.as_deref(), Some("9"));
    assert_eq!(st.backstop[1].slack.as_deref(), Some("0"));
    assert_eq!(st.backstop[2].bps, Some(2000));
    assert_eq!(st.backstop[3].threshold.as_deref(), Some(u128::MAX.to_string().as_str()));
    assert_eq!(st.backstop[4].market, None, "a repayment sync has no deficit market");
    assert_eq!(st.backstop[4].repaid_debt.as_deref(), Some("4"));
    let back = State::from_snapshot(&st.to_snapshot(), &st).expect("snapshot restores the new rows");
    assert_eq!(back.backstop, st.backstop);
    assert_eq!(back.digest(), st.digest());
}

#[test]
fn order_lifecycle_from_events() {
    let st = apply_script(&scenario());
    let o = |id: u64| st.orders.get(&id).unwrap();
    assert_eq!(o(1).status, OrderStatus::Filled);
    assert_eq!(o(1).filled, BTC);
    assert_eq!(o(1).remaining, 0);
    assert_eq!(o(1).avg_fill_price, Some(50_000 * PX as u128));
    assert_eq!(o(2).status, OrderStatus::Filled);
    assert_eq!(o(2).tif, "ioc");
    assert_eq!(o(4).status, OrderStatus::PartiallyFilled);
    assert_eq!(o(4).remaining, BTC - BTC / 4);
    assert_eq!(o(5).status, OrderStatus::Expired);
    assert_eq!(o(6).status, OrderStatus::Rejected);
    assert_eq!(o(7).status, OrderStatus::Canceled);
    assert_eq!(o(7).filled, BTC / 4);
    assert_eq!(o(8).status, OrderStatus::Canceled);
    assert_eq!(o(8).filled, 0);
    // fills carry the taker order id taken from the same-tx OrderAccepted
    assert_eq!(st.fills[0].taker_order_id, Some(2));
    assert_eq!(st.fills[1].taker_order_id, Some(3));
    assert_eq!(st.fills[2].taker_order_id, Some(7));
}

#[test]
fn book_levels_and_sequence_numbers() {
    let st = apply_script(&scenario());
    let (seq, bids, asks) = st.book_snapshot(0, 10);
    // only D's remaining 0.75 BTC @49k is still resting; 51k/51.5k asks were expired/rejected away
    assert_eq!(bids, vec![(49_000 * PX, BTC - BTC / 4)]);
    assert!(asks.is_empty());
    // book-changing events: rest1, fill, fill(final, after Filled-cancel), rest4, rest5, rest6, fill(D), expire5, reject6 = 9
    assert_eq!(seq, 9);
}

#[test]
fn book_deltas_are_gapless_and_reconstruct_the_snapshot() {
    let events = scenario().all_events();
    let mut st = State::new();
    let mut local: std::collections::BTreeMap<(String, u64), u128> = Default::default();
    let mut last = 0u64;
    for e in &events {
        for o in st.apply(e) {
            if let Out::Book(d) = o {
                assert_eq!(d.seq, last + 1, "sequence must be gapless per market");
                last = d.seq;
                if d.size == 0 {
                    local.remove(&(d.side.to_string(), d.price));
                } else {
                    local.insert((d.side.to_string(), d.price), d.size);
                }
            }
        }
    }
    let (_, bids, asks) = st.book_snapshot(0, 100);
    let mut from_snapshot: std::collections::BTreeMap<(String, u64), u128> = Default::default();
    for (p, s) in bids {
        from_snapshot.insert(("bid".into(), p), s);
    }
    for (p, s) in asks {
        from_snapshot.insert(("ask".into(), p), s);
    }
    assert_eq!(local, from_snapshot);
}

// ------------------------------------------------------------------------------------------------ candles

#[test]
fn candle_aggregation_ohlcv_and_buckets() {
    let mut st = State::new();
    let mut s = Script::new();
    // two fills in minute [960,1020), one in [1020,1080) and one in the next hour
    s.push(
        0,
        1_000,
        vec![vec![
            accepted(1, 1, false, 100 * PX, 10 * BTC, 0),
            rested(1, 10 * BTC),
            accepted(2, 2, true, 100 * PX, BTC, 1),
            fill(0, 1, 1, 2, true, 100 * PX, BTC),
        ]],
    );
    s.push(
        0,
        1_010,
        vec![vec![accepted(3, 2, true, 110 * PX, 2 * BTC, 1), fill(1, 1, 1, 2, true, 100 * PX, 2 * BTC)]],
    );
    s.push(
        0,
        1_020,
        vec![vec![accepted(4, 2, false, 90 * PX, BTC, 1), fill(2, 1, 1, 2, false, 100 * PX, BTC / 2)]],
    );
    // a better-priced maker for a distinct price path (low then high inside the same minute)
    s.push(
        0,
        3_700,
        vec![vec![accepted(5, 2, true, 100 * PX, BTC, 1), fill(3, 1, 1, 2, true, 100 * PX, BTC)]],
    );
    st.apply_all(&s.all_events());
    let m1 = &st.candles[&(0, Interval::M1)];
    let c = &m1[&960];
    assert_eq!((c.o, c.h, c.l, c.c), (100 * PX, 100 * PX, 100 * PX, 100 * PX));
    assert_eq!(c.v, 3 * BTC);
    assert_eq!(c.n, 2);
    assert_eq!(c.qv, 300 * 1_000_000); // 3 BTC * $100
    let c = &m1[&1020];
    assert_eq!(c.v, BTC / 2);
    assert_eq!(c.n, 1);
    let h1 = &st.candles[&(0, Interval::H1)];
    assert_eq!(h1[&0].n, 3, "first hour holds the first three fills");
    assert_eq!(h1[&0].v, 3 * BTC + BTC / 2);
    assert_eq!(h1[&3600].n, 1);
    let m5 = &st.candles[&(0, Interval::M5)];
    assert_eq!(m5[&900].n, 3);
}

#[test]
fn candle_high_low_track_price_moves() {
    let mut st = State::new();
    let mut s = Script::new();
    let mk = |trade: u64, px: u64| vec![accepted(10 + trade, 2, true, px, BTC, 1), fill(trade, 1, 1, 2, true, px, BTC)];
    let mut tx = vec![accepted(1, 1, false, 100 * PX, 100 * BTC, 0), rested(1, 100 * BTC)];
    tx.extend(mk(0, 100 * PX));
    tx.extend(mk(1, 105 * PX));
    tx.extend(mk(2, 95 * PX));
    tx.extend(mk(3, 101 * PX));
    s.push(0, 600, vec![tx]);
    st.apply_all(&s.all_events());
    let c = &st.candles[&(0, Interval::M1)][&600];
    assert_eq!((c.o, c.h, c.l, c.c, c.n), (100 * PX, 105 * PX, 95 * PX, 101 * PX, 4));
}

// ------------------------------------------------------------------------------------------------ positions

#[test]
fn position_math_matches_spec_worked_example() {
    // SPEC: long 1@50k + 1@51k -> basis 101,000; sell 3@52k -> realized +3,000; new short 1@52k.
    let (mut size, mut basis) = (0i128, 0i128);
    let b = BTC as i128;
    apply_position_fill(&mut size, &mut basis, b, 50_000 * PX);
    apply_position_fill(&mut size, &mut basis, b, 51_000 * PX);
    assert_eq!(size, 2 * b);
    assert_eq!(basis, 2 * b * 50_500 * PX as i128);
    let (pnl, ov) = apply_position_fill(&mut size, &mut basis, -3 * b, 52_000 * PX);
    assert!(!ov);
    assert_eq!(pnl, 3_000 * 1_000_000);
    assert_eq!(size, -b);
    assert_eq!(basis, -b * 52_000 * PX as i128);
    // flatten
    apply_position_fill(&mut size, &mut basis, b, 52_000 * PX);
    assert_eq!((size, basis), (0, 0));
}

#[test]
fn positions_oi_fees_and_funding_from_events() {
    let st = apply_script(&scenario());
    let p = |a: u8| st.positions.get(&(acct(a), 0)).unwrap();
    assert_eq!(p(1).size, -(BTC as i128)); // A sold 1 BTC
    assert_eq!(p(2).size, 2 * BTC as i128 / 5);
    assert_eq!(p(3).size, 3 * BTC as i128 / 5);
    assert_eq!(p(4).size, BTC as i128 / 4);
    assert_eq!(p(7).size, -(BTC as i128 / 4));
    assert_eq!(p(1).entry_price, Some(50_000 * PX as u128));
    assert_eq!(p(1).fees_paid, -2); // two maker rebates of -1
    assert_eq!(p(2).fees_paid, 10);
    assert_eq!(p(3).funding_paid, 7);
    // OI = sum of long sizes = 0.4 + 0.6 + 0.25
    assert_eq!(st.markets[&0].open_interest, BTC * 125 / 100);
    let m = &st.markets[&0];
    assert_eq!(m.last_price, Some(49_000 * PX));
    assert_eq!(m.state, 1);
    assert_eq!(m.funding_rate, 40_000_000);
    assert_eq!(m.trade_count, 3);
}

#[test]
fn liquidation_adl_twap_and_conditionals() {
    let mut s = Script::new();
    s.push(
        0,
        10,
        vec![vec![
            accepted(1, 1, false, 50_000 * PX, BTC, 0),
            rested(1, BTC),
            accepted(2, 2, true, 50_000 * PX, BTC, 1),
            fill(0, 1, 1, 2, true, 50_000 * PX, BTC),
        ]],
    );
    // liquidation of the long (acct 2) for half to the backstop; open orders cancelled first
    s.push(
        0,
        20,
        vec![vec![
            Ev::Liquidated {
                acct: acct(2),
                market: 0,
                keeper: Address::repeat_byte(9),
                size: BTC / 2,
                price: 45_500 * PX,
                fee: 1_000,
                bad_debt: 5,
            },
            Ev::BadDebtUnresolved { acct: acct(2), amount: 5 },
        ]],
    );
    s.push(
        0,
        30,
        vec![vec![Ev::AdlExecuted {
            target: acct(1),
            market: 0,
            size: BTC / 4,
            price: 45_000 * PX,
            debt_cleared: 5,
            mark_price: None,
        }]],
    );
    // TWAP: placed, slice ok, slice failed, done
    s.push(
        0,
        40,
        vec![vec![Ev::TwapPlaced {
            id: 1,
            acct: acct(2),
            market: 0,
            is_buy: true,
            total: BTC,
            slices: 4,
            interval: 60,
            slippage_bps: 100,
            reduce_only: false,
        }]],
    );
    s.push(
        0,
        50,
        vec![vec![
            accepted(10, 2, true, 51_000 * PX, BTC / 4, 1),
            Ev::TwapSlice {
                id: 1,
                slice_index: 0,
                filled: BTC / 4,
                ok: true,
            },
        ]],
    );
    s.push(
        0,
        60,
        vec![vec![
            Ev::TwapSlice {
                id: 1,
                slice_index: 1,
                filled: 0,
                ok: false,
            },
            Ev::TwapDone {
                id: 1,
                filled: BTC / 4,
                failed: 1,
            },
        ]],
    );
    // conditional: placed twice (bracket), one triggers (cancel sibling + cancel self precede Triggered), child order accepted
    s.push(
        0,
        70,
        vec![vec![
            Ev::CondPlaced {
                id: 1,
                acct: acct(2),
                market: 0,
                is_buy: false,
                above: true,
                trigger: 55_000 * PX,
                limit: 54_900 * PX,
                size: BTC / 4,
                reduce_only: true,
                sibling: 2,
            },
            Ev::CondPlaced {
                id: 2,
                acct: acct(2),
                market: 0,
                is_buy: false,
                above: false,
                trigger: 45_000 * PX,
                limit: 44_900 * PX,
                size: BTC / 4,
                reduce_only: true,
                sibling: 1,
            },
        ]],
    );
    s.push(
        0,
        80,
        vec![vec![
            Ev::CondCanceled { id: 1 },
            Ev::CondCanceled { id: 2 },
            Ev::CondTriggered {
                id: 1,
                mark_price: 55_100 * PX,
            },
            accepted(11, 2, false, 54_900 * PX, BTC / 4, 1),
            canceled(11, cancel::USER, BTC / 4),
        ]],
    );
    let st = apply_script(&s);
    assert_eq!(st.liquidations.len(), 1);
    assert_eq!(st.liquidations[0].bad_debt, 5);
    // acct2: long 1, liquidated 0.5 -> 0.5; then TWAP order is an accepted-only stub (no fill events), so size stays 0.5
    assert_eq!(st.positions[&(acct(2), 0)].size, BTC as i128 / 2);
    // liquidation realised pnl: 0.5 * (45.5k - 50k) = -2250
    assert_eq!(st.positions[&(acct(2), 0)].realized_pnl, -2_250 * 1_000_000);
    let bs = &st.positions[&(backstop_key(), 0)];
    assert_eq!(bs.size, BTC as i128 / 2 - BTC as i128 / 4);
    assert!(bs.approximate && bs.realized_pnl_error_bound > 0);
    assert_eq!(st.bad_debt.iter().map(|b| b.kind).collect::<Vec<_>>(), vec!["bad_debt_unresolved", "adl"]);
    let t = &st.twaps[&1];
    assert_eq!(
        (t.status, t.filled, t.slices_done, t.slices_failed, t.slice_log.len()),
        ("done", BTC / 4, 2, 1, 2)
    );
    assert_eq!(st.orders[&10].parent, Some(ParentRef { kind: "twap", id: 1 }));
    assert_eq!(st.conds[&1].status, "triggered");
    assert_eq!(st.conds[&1].trigger_mark_price, Some(55_100 * PX));
    assert_eq!(st.conds[&2].status, "canceled", "OCO sibling");
    assert_eq!(st.orders[&11].parent, Some(ParentRef { kind: "conditional", id: 1 }));
}

// ------------------------------------------------------------------------------------------------ idempotence / replay

#[test]
fn ingesting_same_logs_twice_equals_once() {
    let events = scenario().all_events();
    let mut once = State::new();
    once.apply_all(&events);
    let mut twice = State::new();
    twice.apply_all(&events);
    let out = twice.apply_all(&events);
    assert!(out.is_empty(), "duplicates must produce no side effects");
    assert_eq!(once.digest(), twice.digest());
    assert_eq!(twice.counters.duplicates_skipped as usize, events.len());
    // re-delivery of a window in the middle is also a no-op
    let mut mid = State::new();
    mid.apply_all(&events);
    mid.apply_all(&events[3..8]);
    assert_eq!(once.digest(), mid.digest());
}

#[test]
fn replay_from_scratch_equals_incremental_in_any_chunking() {
    let events = scenario().all_events();
    let mut full = State::new();
    full.apply_all(&events);
    for chunk in [1usize, 2, 3, 7, 1000] {
        let mut inc = State::new();
        for c in events.chunks(chunk) {
            inc.apply_all(c);
        }
        assert_eq!(full.digest(), inc.digest(), "chunk={chunk}");
    }
    // through serialisation (what the DB does): JSON roundtrip of every event
    let rt: Vec<EventRecord> = events
        .iter()
        .map(|e| serde_json::from_str(&serde_json::to_string(e).unwrap()).unwrap())
        .collect();
    let mut st = State::new();
    st.apply_all(&rt);
    assert_eq!(full.digest(), st.digest());
}

#[tokio::test]
async fn store_commit_is_idempotent_on_event_key() {
    let s = scenario();
    let store = MemStore::new();
    let (blk, evs) = &s.blocks[3];
    let a = store.commit_block(blk, evs).await.unwrap();
    let b = store.commit_block(blk, evs).await.unwrap();
    assert_eq!(a, 3);
    assert_eq!(b, 0, "second commit inserts nothing");
    assert_eq!(store.load_events(None, 100).await.unwrap().len(), 3);
}

// ------------------------------------------------------------------------------------------------ indexer + reorgs

struct FakeChain {
    blocks: Mutex<Vec<(BlockRef, Vec<EventRecord>)>>,
}
impl FakeChain {
    fn from(s: &Script) -> Arc<Self> {
        Arc::new(Self {
            blocks: Mutex::new(s.blocks.clone()),
        })
    }
    fn replace(&self, s: &Script) {
        *self.blocks.lock().unwrap() = s.blocks.clone();
    }
}
#[async_trait]
impl ChainSource for FakeChain {
    async fn head(&self) -> anyhow::Result<u64> {
        Ok(self.blocks.lock().unwrap().len() as u64 - 1)
    }
    async fn header(&self, n: u64) -> anyhow::Result<Option<BlockRef>> {
        Ok(self.blocks.lock().unwrap().get(n as usize).map(|b| b.0.clone()))
    }
    async fn events(&self, from: u64, to: u64, _ts: &HashMap<u64, u64>) -> anyhow::Result<Vec<EventRecord>> {
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.0.number >= from && b.0.number <= to)
            .flat_map(|b| b.1.clone())
            .collect())
    }
    async fn rpc_finalized(&self) -> Option<u64> {
        None
    }
}

fn cfg(batch: u64, window: usize) -> IndexerCfg {
    IndexerCfg {
        start_block: 0,
        batch,
        reorg_window: window,
        confirmations: 0,
        poll_ms: 1,
        snapshot_every: 0,
        snapshot_keep: 4,
        block_retention: 0,
        prefetch: false,
    }
}

fn indexer(chain: Arc<FakeChain>, store: Arc<MemStore>, batch: u64, window: usize) -> Indexer {
    Indexer::new(chain, store, Arc::new(Shared::new(64, 5)), cfg(batch, window))
}

async fn drain(ix: &Indexer) {
    for _ in 0..1000 {
        if !ix.step().await.unwrap() {
            return;
        }
    }
    panic!("indexer never went idle");
}

#[tokio::test]
async fn indexer_batching_does_not_change_read_models() {
    let s = scenario();
    let expect = apply_script(&s).digest();
    for batch in [1u64, 2, 100] {
        let ix = indexer(FakeChain::from(&s), Arc::new(MemStore::new()), batch, 16);
        ix.bootstrap().await.unwrap();
        drain(&ix).await;
        assert_eq!(ix.shared.state.read().unwrap().digest(), expect, "batch={batch}");
        // restart from the checkpoint with a brand-new process state: replay == incremental
        let ix2 = Indexer::new(ix.chain.clone(), ix.store.clone(), Arc::new(Shared::new(64, 5)), ix.cfg.clone());
        ix2.bootstrap().await.unwrap();
        assert_eq!(ix2.shared.state.read().unwrap().digest(), expect);
        drain(&ix2).await; // nothing new: no change
        assert_eq!(ix2.shared.state.read().unwrap().digest(), expect);
    }
}

#[tokio::test]
async fn reorg_rolls_back_derived_rows_and_reingests() {
    let a = scenario();
    let chain = FakeChain::from(&a);
    let store = Arc::new(MemStore::new());
    let ix = indexer(chain.clone(), store.clone(), 100, 16);
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    let before = ix.shared.state.read().unwrap().digest();
    assert!(ix.shared.state.read().unwrap().orders.contains_key(&8));

    // fork at block 4: blocks 5.. are replaced by a different history (salt=1)
    let mut b = Script::new();
    b.blocks = a.blocks[..5].to_vec(); // keeps blocks 0..=4
    b.push(
        1,
        1_170,
        vec![vec![
            accepted(7, 9, true, 49_000 * PX, BTC / 10, 1),
            fill(2, 4, 4, 9, true, 49_000 * PX, BTC / 10),
        ]],
    );
    b.push(
        1,
        1_200,
        vec![vec![
            accepted(8, 9, true, 49_000 * PX, BTC / 10, 1),
            fill(3, 4, 4, 9, true, 49_000 * PX, BTC / 10),
        ]],
    );
    b.push(1, 1_230, vec![vec![accepted(9, 9, false, 52_000 * PX, BTC, 0), rested(9, BTC)]]);
    b.push(1, 1_260, vec![vec![]]);
    b.push(1, 1_290, vec![vec![]]);
    b.push(1, 1_300, vec![vec![]]);
    chain.replace(&b);
    drain(&ix).await;

    let canonical = apply_script(&b);
    {
        let st = ix.shared.state.read().unwrap();
        assert_eq!(st.digest(), canonical.digest(), "state after reorg == replay of the new canonical chain");
        assert_ne!(st.digest(), before);
        assert_eq!(st.orders[&7].acct, acct(9), "order id 7 now belongs to the new branch");
        assert!(!st.orders.values().any(|o| o.acct == acct(7)), "orphaned branch rows are gone");
        assert_eq!(st.orders[&9].status, OrderStatus::Open);
    }
    let tip = store.tip().await.unwrap().unwrap();
    assert_eq!(tip.number, b.blocks.len() as u64 - 1);
    assert_eq!(tip.hash, b.blocks.last().unwrap().0.hash);
    assert_eq!(crate::shared::Metrics::get(&ix.shared.metrics.reorgs), 1);
    // and the persisted log rebuilds the same state (replay == incremental after a reorg)
    let (rebuilt, _) = ix.rebuild_state(store.tip().await.unwrap().map(|t| t.number)).await.unwrap();
    assert_eq!(rebuilt.digest(), canonical.digest());
}

#[tokio::test]
async fn reorg_detected_by_parent_hash_mismatch_when_tip_hash_still_matches() {
    // Node swaps the history *after* our tip too (new block N+1 whose parent is a different N).
    let a = scenario();
    let chain = FakeChain::from(&a);
    let ix = indexer(chain.clone(), Arc::new(MemStore::new()), 100, 16);
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    let tip = a.blocks.len() as u64 - 1;
    let mut b = Script::new();
    b.blocks = a.blocks[..tip as usize].to_vec(); // drop our tip block
    b.push(2, 9_999, vec![vec![accepted(50, 5, true, PX, BTC, 0), rested(50, BTC)]]); // different block at same height
    b.push(2, 10_000, vec![vec![]]);
    chain.replace(&b);
    drain(&ix).await;
    assert_eq!(ix.shared.state.read().unwrap().digest(), apply_script(&b).digest());
}

// ------------------------------------------------------------------------------------------------ API

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn api_with_state(rps: f64, burst: f64) -> (axum::Router, Arc<Shared>) {
    let shared = prep_shared(usize::MAX);
    (
        router(App::new(
            shared.clone(),
            Arc::new(Security::local(SecurityCfg {
                ip_rps: rps,
                ip_burst: burst,
                ..Default::default()
            })),
        )),
        shared,
    )
}

fn prep_shared(max_fills: usize) -> Arc<Shared> {
    let shared = Arc::new(Shared::new(8, 5));
    {
        let mut st = shared.state.write().unwrap();
        st.max_fills = max_fills;
        st.apply_all(&scenario().all_events());
        st.meta.insert(
            0,
            MarketMeta {
                name: Some("BTC-USD".into()),
                tick: Some(100_000),
                ..Default::default()
            },
        );
    }
    {
        let mut c = shared.chain.write().unwrap();
        c.chain_id = 31337;
        c.exchange = "0xabc".into();
        c.chain_head = Some(7);
        c.bootstrapped = true;
        c.indexed = Some(BlockRef {
            number: 7,
            hash: B256::ZERO,
            parent_hash: B256::ZERO,
            ts: 3_760,
        });
    }
    shared
}

async fn get_json(app: &axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let r = app.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
    let st = r.status();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (st, serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null))
}

#[tokio::test]
async fn api_trades_candles_book_status() {
    let (app, _) = api_with_state(0.0, 1.0);
    let (c, j) = get_json(&app, "/v1/markets/0/trades?order=asc").await;
    assert_eq!(c, StatusCode::OK);
    let d = j["data"].as_array().unwrap();
    assert_eq!(d.len(), 3);
    assert_eq!(d[0]["size"], "40000000");
    assert_eq!(d[0]["price"], "50000000000");
    assert_eq!(d[0]["taker_order_id"], 2);
    assert_eq!(j["indexed_block"], 7);

    let (_, j) = get_json(&app, "/v1/markets/0/candles?interval=1m").await;
    let cs = j["data"]["candles"].as_array().unwrap();
    assert_eq!(cs[0]["t"], 1020);
    assert_eq!(cs[0]["v"], "40000000");

    let (_, j) = get_json(&app, "/v1/markets/0/book").await;
    assert_eq!(j["data"]["seq"], 9);
    assert_eq!(j["data"]["bids"][0][0], "49000000000");
    assert_eq!(j["data"]["bids"][0][1], "75000000");

    let (_, j) = get_json(&app, "/v1/status").await;
    assert_eq!(j["data"]["lag_blocks"], 0);
    assert_eq!(j["data"]["parent_chain_finality"]["status"], "unknown");
    assert_eq!(j["data"]["canonical_execution"]["block"], 7);
    assert_eq!(j["data"]["indexed_head"]["number"], 7);

    let (_, j) = get_json(&app, "/v1/markets").await;
    assert_eq!(j["data"][0]["name"], "BTC-USD");
    assert_eq!(j["data"][0]["state_name"], "reduce_only");
}

#[tokio::test]
async fn api_pagination_cursor_walks_all_rows_without_overlap() {
    let (app, _) = api_with_state(0.0, 1.0);
    let mut seen = vec![];
    let mut cursor = String::new();
    for _ in 0..10 {
        let uri = format!(
            "/v1/markets/0/trades?limit=2&order=asc{}",
            if cursor.is_empty() { String::new() } else { format!("&cursor={cursor}") }
        );
        let (_, j) = get_json(&app, &uri).await;
        for t in j["data"].as_array().unwrap() {
            seen.push(t["trade_id"].as_str().unwrap().to_string());
        }
        match j["next_cursor"].as_str() {
            Some(c) => cursor = c.to_string(),
            None => break,
        }
    }
    assert_eq!(seen, vec!["0", "1", "2"]);
    // descending default: newest first
    let (_, j) = get_json(&app, "/v1/markets/0/trades?limit=1").await;
    assert_eq!(j["data"][0]["trade_id"], "2");
    assert!(j["next_cursor"].is_string());
}

#[tokio::test]
async fn api_account_views_and_status_filter() {
    let (app, _) = api_with_state(0.0, 1.0);
    let a1 = format!("0x{}", "01".repeat(32));
    let (_, j) = get_json(&app, &format!("/v1/accounts/{a1}/orders?status=filled")).await;
    assert_eq!(j["data"].as_array().unwrap().len(), 1);
    assert_eq!(j["data"][0]["id"], 1);
    let a4 = format!("0x{}", "04".repeat(32));
    let (_, j) = get_json(&app, &format!("/v1/accounts/{a4}/orders?status=partially_filled")).await;
    assert_eq!(j["data"][0]["remaining"], "75000000");
    let (_, j) = get_json(&app, &format!("/v1/accounts/{a1}/fills")).await;
    assert_eq!(j["data"].as_array().unwrap().len(), 2);
    assert_eq!(j["data"][0]["role"], "maker");
    let (_, j) = get_json(&app, &format!("/v1/accounts/{a1}/positions")).await;
    assert_eq!(j["data"][0]["size"], "-100000000");
    let (_, j) = get_json(&app, &format!("/v1/accounts/{a1}/transfers?kind=deposit")).await;
    assert_eq!(j["data"].as_array().unwrap().len(), 1);
    assert_eq!(j["data"][0]["amount"], "1000000000");
    let (_, j) = get_json(&app, "/v1/markets/0/funding").await;
    assert_eq!(j["data"][0]["rate"], "40000000");
    let (_, j) = get_json(&app, "/v1/orders/5").await;
    assert_eq!(j["data"]["status"], "expired");
}

#[tokio::test]
async fn api_owner_address_resolves_to_account_key() {
    let (app, _) = api_with_state(0.0, 1.0);
    let owner = Address::repeat_byte(0x11);
    let key = acct_key(owner, 3);
    // keccak256(abi.encode(address,uint8)) known-answer check against an independent construction
    let mut enc = [0u8; 64];
    enc[12..32].copy_from_slice(owner.as_slice());
    enc[63] = 3;
    assert_eq!(key, keccak256(enc));
    let (c, j) = get_json(&app, &format!("/v1/accounts/{owner}/positions?sub=3")).await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(j["data"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn api_stable_error_codes() {
    let (app, _) = api_with_state(0.0, 1.0);
    for (uri, status, code) in [
        ("/v1/markets/99", 404, "not_found"),
        ("/v1/markets/abc", 400, "invalid_argument"),
        ("/v1/markets/0/trades?limit=0", 400, "invalid_argument"),
        ("/v1/markets/0/trades?limit=99999", 400, "invalid_argument"),
        ("/v1/markets/0/trades?cursor=zz", 400, "invalid_argument"),
        ("/v1/markets/0/trades?order=sideways", 400, "invalid_argument"),
        ("/v1/markets/0/candles?interval=7m", 400, "invalid_argument"),
        ("/v1/accounts/0x1234/orders", 400, "invalid_argument"),
        ("/v1/orders/999", 404, "not_found"),
        ("/v1/orders/x", 400, "invalid_argument"),
        ("/v1/nope", 404, "not_found"),
    ] {
        let (c, j) = get_json(&app, uri).await;
        assert_eq!(c.as_u16(), status, "{uri}");
        assert_eq!(j["code"], code, "{uri}");
        assert!(j["message"].is_string(), "{uri}");
    }
    let r = app
        .clone()
        .oneshot(Request::builder().method("POST").uri("/v1/markets").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn api_rate_limit_returns_429_with_code_and_ops_endpoints_exempt() {
    let (app, shared) = api_with_state(0.5, 3.0);
    for _ in 0..3 {
        assert_eq!(get_json(&app, "/v1/status").await.0, StatusCode::OK);
    }
    let r = app
        .clone()
        .oneshot(Request::builder().uri("/v1/status").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(r.headers().contains_key("retry-after"));
    let b = r.into_body().collect().await.unwrap().to_bytes();
    let j: serde_json::Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(j["code"], "rate_limited");
    for _ in 0..10 {
        assert_eq!(get_json(&app, "/healthz").await.0, StatusCode::OK);
    }
    assert_eq!(get_json(&app, "/readyz").await.0, StatusCode::OK);
    assert!(crate::shared::Metrics::get(&shared.metrics.rate_limited) >= 1);
}

#[tokio::test]
async fn readyz_fails_when_lagging_and_metrics_render() {
    let (app, shared) = api_with_state(0.0, 1.0);
    shared.chain.write().unwrap().chain_head = Some(100);
    let (c, j) = get_json(&app, "/readyz").await;
    assert_eq!(c, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(j["code"], "not_ready");
    let r = app
        .clone()
        .oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let b = String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(b.contains("indexer_lag_blocks 93"));
    assert!(b.contains("indexer_events_total{event=\"Fill\"} 3"));
}

// ------------------------------------------------------------------------------------------------ websocket

async fn ws_next<S>(ws: &mut S) -> serde_json::Value
where
    S: futures_util::Stream<Item = Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    use futures_util::StreamExt;
    let m = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str::<serde_json::Value>(m.to_text().unwrap()).unwrap()
}

#[tokio::test]
async fn websocket_snapshot_then_deltas_with_sequence_numbers_and_resnapshot() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message as M;
    let shared = Arc::new(Shared::new(8, 5));
    shared.chain.write().unwrap().bootstrapped = true;
    let app = router(App::new(
        shared.clone(),
        Arc::new(Security::local(SecurityCfg {
            ip_rps: 0.0,
            ..Default::default()
        })),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap()
    });
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws")).await.unwrap();
    ws.send(M::text(r#"{"op":"subscribe","channel":"book","market":0}"#)).await.unwrap();
    ws.send(M::text(r#"{"op":"subscribe","channel":"trades","market":0}"#)).await.unwrap();
    let mut got = vec![];
    for _ in 0..3 {
        got.push(ws_next(&mut ws).await);
    }
    assert_eq!(got[0]["type"], "subscribed");
    let snap = got.iter().find(|m| m["type"] == "snapshot").expect("snapshot sent after subscribe");
    assert_eq!(snap["seq"], 0);

    // push events through the same path the indexer uses
    {
        let mut st = shared.state.write().unwrap();
        let s = scenario();
        let outs = st.apply_all(&s.all_events()[..2]); // accepted + rested
        shared.hub.publish(&outs);
    }
    let mut deltas = vec![];
    while deltas.is_empty() {
        let m = ws_next(&mut ws).await;
        if m["type"] == "delta" {
            deltas.push(m);
        }
    }
    assert_eq!(deltas[0]["seq"], 1);
    assert_eq!(deltas[0]["side"], "ask");
    assert_eq!(deltas[0]["size"], "100000000");

    // client detects a gap (pretend it missed seq) and asks for a resnapshot at the current seq
    ws.send(M::text(r#"{"op":"resnapshot","channel":"book","market":0}"#)).await.unwrap();
    loop {
        let m = ws_next(&mut ws).await;
        if m["type"] == "snapshot" {
            assert_eq!(m["seq"], 1);
            assert_eq!(m["asks"][0][1], "100000000");
            break;
        }
    }
    ws.send(M::text(r#"{"op":"subscribe","channel":"nope"}"#)).await.unwrap();
    loop {
        let m = ws_next(&mut ws).await;
        if m["type"] == "error" {
            assert_eq!(m["code"], "unknown_channel");
            break;
        }
    }
}

#[tokio::test]
async fn websocket_slow_client_is_closed_with_4008() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as M;
    let shared = Arc::new(Shared::new(2, 5)); // tiny queue
    let app = router(App::new(
        shared.clone(),
        Arc::new(Security::local(SecurityCfg {
            ip_rps: 0.0,
            ..Default::default()
        })),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap()
    });
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws")).await.unwrap();
    ws.send(M::text(r#"{"op":"subscribe","channel":"trades","market":0}"#)).await.unwrap();
    // wait for ack
    let _ = ws.next().await;
    // publish a burst larger than the queue before the client reads anything more
    let mut st = State::new();
    let s = scenario();
    let mut outs = vec![];
    for e in s.all_events() {
        outs.extend(st.apply(&e));
    }
    // the writer task drains concurrently, so flood far beyond the queue size in one synchronous publish
    let flood: Vec<Out> = (0..500)
        .flat_map(|_| outs.iter().filter(|o| matches!(o, Out::Trade(_))).cloned().collect::<Vec<_>>())
        .collect();
    shared.hub.publish(&flood);
    let mut closed_code = None;
    while let Ok(Some(Ok(m))) = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
        if let M::Close(Some(f)) = m {
            closed_code = Some(u16::from(f.code));
            break;
        }
    }
    assert_eq!(closed_code, Some(4008));
    assert_eq!(shared.hub.dropped_slow.load(std::sync::atomic::Ordering::Relaxed), 1);
}

// ------------------------------------------------------------------------------------------------ paging helper

#[test]
fn page_idx_asc_desc_filters_and_cursor() {
    let keys: Vec<u128> = (0..10).map(|i| i * 10).collect();
    let k = |i: usize| keys[i];
    let p = page_idx(10, k, None, 3, false, |_| true);
    assert_eq!((p.idx.clone(), p.next), (vec![0, 1, 2], Some(20)));
    let p = page_idx(10, k, Some(20), 3, false, |_| true);
    assert_eq!((p.idx.clone(), p.next), (vec![3, 4, 5], Some(50)));
    let p = page_idx(10, k, Some(70), 5, false, |_| true);
    assert_eq!((p.idx.clone(), p.next), (vec![8, 9], None));
    let p = page_idx(10, k, None, 3, true, |_| true);
    assert_eq!((p.idx.clone(), p.next), (vec![9, 8, 7], Some(70)));
    let p = page_idx(10, k, Some(70), 3, true, |i| i % 2 == 0);
    assert_eq!((p.idx.clone(), p.next), (vec![6, 4, 2], Some(20)));
}

// ================================================================================================ snapshots / replay bounds

use crate::state::SNAPSHOT_VERSION;

/// `n` consecutive blocks (1..=n), each with one resting ask that a taker immediately fills (5 events per block).
/// `fork_at`/`salt` replaces everything after block `fork_at` by a different branch.
fn long_chain(n: u64, fork_at: Option<u64>, salt: u8, base: Option<&Script>) -> Script {
    let mut s = Script::new();
    if let (Some(f), Some(b)) = (fork_at, base) {
        s.blocks = b.blocks[..=f as usize].to_vec();
    }
    while (s.blocks.len() as u64) <= n {
        let i = s.blocks.len() as u64;
        let (m, t) = (2 * i - 1, 2 * i);
        let px = (50_000 + i) * PX + salt as u64;
        s.push(
            salt,
            1_000 + 10 * i,
            vec![vec![
                accepted(m, 1, false, px, BTC / 10, 0),
                rested(m, BTC / 10),
                accepted(t, 2, true, px, BTC / 10, 1),
                canceled(m, cancel::FILLED, 0),
                fill(i, m, 1, 2, true, px, BTC / 10),
            ]],
        );
    }
    s
}
const EV_PER_BLOCK: u64 = 5;

fn snap_cfg(batch: u64, window: usize, every: u64) -> IndexerCfg {
    IndexerCfg {
        snapshot_every: every,
        ..cfg(batch, window)
    }
}

#[test]
fn snapshot_plus_tail_equals_full_replay_for_every_split_point() {
    let s = scenario();
    let full = apply_script(&s);
    let full_snap = full.to_snapshot();
    assert!(full_snap.contains(&format!("\"version\":{SNAPSHOT_VERSION}")));
    for k in 0..s.blocks.len() {
        let mut head = State::new();
        for b in &s.blocks[..=k] {
            head.apply_all(&b.1);
        }
        let mut restored = State::from_snapshot(&head.to_snapshot(), &State::new()).expect("snapshot loads");
        assert_eq!(restored.digest(), head.digest(), "snapshot round trip at block {k}");
        for b in &s.blocks[k + 1..] {
            restored.apply_all(&b.1);
        }
        assert_eq!(restored.digest(), full.digest(), "snapshot@{k} + tail == full replay");
        assert_eq!(
            restored.to_snapshot(),
            full_snap,
            "snapshot@{k} + tail re-serialises byte-identically (indexes rebuilt)"
        );
    }
}

#[test]
fn snapshot_rejects_wrong_version_and_garbage() {
    let st = apply_script(&scenario());
    let bad = st.to_snapshot().replacen(&format!("\"version\":{SNAPSHOT_VERSION}"), "\"version\":999", 1);
    assert!(State::from_snapshot(&bad, &State::new()).is_err());
    assert!(State::from_snapshot("{not json", &State::new()).is_err());
}

#[tokio::test]
async fn startup_and_reorg_replay_only_the_tail_after_the_newest_snapshot() {
    let a = long_chain(65, None, 0, None);
    let chain = FakeChain::from(&a);
    let store = Arc::new(MemStore::new());
    let mut c8 = snap_cfg(7, 16, 10);
    c8.snapshot_keep = 8;
    let ix = Indexer::new(chain.clone(), store.clone(), Arc::new(Shared::new(64, 5)), c8.clone());
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    assert_eq!(
        store.snapshot_blocks(),
        vec![10, 20, 30, 40, 50, 60],
        "a snapshot every 10 blocks (inside multi-block batches too)"
    );
    let total = 65 * EV_PER_BLOCK;
    let expect = apply_script(&a).digest();

    // restart: snapshot@60 + 5 tail blocks, not the whole log
    let ix2 = Indexer::new(chain.clone(), store.clone(), Arc::new(Shared::new(64, 5)), c8.clone());
    ix2.bootstrap().await.unwrap();
    let m = &ix2.shared.metrics;
    assert_eq!(
        crate::shared::Metrics::get(&m.last_replay_events),
        5 * EV_PER_BLOCK,
        "startup replays the 5 blocks after snapshot@60"
    );
    assert_eq!(crate::shared::Metrics::get(&m.last_replay_snapshot_block), 61, "started from snapshot block 60");
    assert!(5 * EV_PER_BLOCK < total / 10);
    assert_eq!(ix2.shared.state.read().unwrap().digest(), expect);

    // shallow reorg (fork at 62): replay <= 2 blocks past snapshot@60
    let b = long_chain(70, Some(62), 1, Some(&a));
    chain.replace(&b);
    let before = store.loaded_events.load(std::sync::atomic::Ordering::Relaxed);
    assert!(ix.step().await.unwrap()); // detects the reorg and rebuilds
    let replayed = crate::shared::Metrics::get(&ix.shared.metrics.last_replay_events);
    assert_eq!(replayed, 2 * EV_PER_BLOCK, "reorg at depth 3 replays only blocks 61..=62 after snapshot@60");
    assert_eq!(store.loaded_events.load(std::sync::atomic::Ordering::Relaxed) - before, replayed);
    drain(&ix).await;
    assert_eq!(
        ix.shared.state.read().unwrap().digest(),
        apply_script(&b).digest(),
        "state == replay of the new canonical chain"
    );

    // deeper reorg (fork at 35): newest snapshot <= 35 is 30; snapshots 40..60 were invalidated and deleted
    let c = long_chain(80, Some(35), 2, Some(&b));
    chain.replace(&c);
    assert!(ix.step().await.unwrap());
    assert_eq!(crate::shared::Metrics::get(&ix.shared.metrics.last_replay_events), 5 * EV_PER_BLOCK);
    assert!(
        store.snapshot_blocks().iter().all(|b| *b <= 35),
        "snapshots of the orphaned branch are gone: {:?}",
        store.snapshot_blocks()
    );
    drain(&ix).await;
    assert_eq!(ix.shared.state.read().unwrap().digest(), apply_script(&c).digest());
    // fresh restart after all of this is still exact
    let ix3 = Indexer::new(chain, store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(7, 16, 10));
    ix3.bootstrap().await.unwrap();
    assert_eq!(ix3.shared.state.read().unwrap().digest(), apply_script(&c).digest());
}

#[tokio::test]
async fn corrupt_or_foreign_snapshot_falls_back_to_older_snapshot_then_full_replay() {
    let a = long_chain(35, None, 0, None);
    let store = Arc::new(MemStore::new());
    let ix = Indexer::new(FakeChain::from(&a), store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(100, 16, 10));
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    assert_eq!(store.snapshot_blocks(), vec![10, 20, 30]);
    // newest snapshot has a hash that disagrees with the stored block; the one below is garbage
    store
        .save_snapshot(&crate::store::Snapshot {
            block: 30,
            block_hash: B256::repeat_byte(9),
            state: "{}".into(),
        })
        .await
        .unwrap();
    store
        .save_snapshot(&crate::store::Snapshot {
            block: 20,
            block_hash: a.blocks[20].0.hash,
            state: "garbage".into(),
        })
        .await
        .unwrap();
    let ix2 = Indexer::new(FakeChain::from(&a), store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(100, 16, 10));
    ix2.bootstrap().await.unwrap();
    assert_eq!(
        crate::shared::Metrics::get(&ix2.shared.metrics.last_replay_snapshot_block),
        11,
        "fell back to the valid snapshot@10"
    );
    assert_eq!(ix2.shared.state.read().unwrap().digest(), apply_script(&a).digest());
}

// ------------------------------------------------------------------------------------------------ deep reorgs

#[tokio::test]
async fn reorg_deeper_than_window_is_reanchored_with_an_alert_not_halted() {
    let a = long_chain(60, None, 0, None);
    let chain = FakeChain::from(&a);
    let store = Arc::new(MemStore::new());
    let ix = Indexer::new(chain.clone(), store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(100, 4, 0));
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    let b = long_chain(66, Some(20), 7, Some(&a)); // 40 blocks deep, window is 4
    chain.replace(&b);
    drain(&ix).await;
    {
        let c = ix.shared.chain.read().unwrap();
        assert!(c.halted.is_none(), "must not halt: {:?}", c.halted);
        assert!(
            c.alert.as_deref().is_some_and(|m| m.contains("deep reorg")),
            "operator alert raised: {:?}",
            c.alert
        );
    }
    assert_eq!(crate::shared::Metrics::get(&ix.shared.metrics.deep_reorgs), 1);
    assert_eq!(crate::shared::Metrics::get(&ix.shared.metrics.last_reorg_depth), 40);
    assert!(ix.shared.is_ready() || ix.shared.lag().is_some());
    assert_eq!(
        ix.shared.state.read().unwrap().digest(),
        apply_script(&b).digest(),
        "re-anchored state == canonical replay"
    );
    assert_eq!(store.tip().await.unwrap().unwrap().hash, b.blocks.last().unwrap().0.hash);
}

#[tokio::test]
async fn entire_stored_history_diverging_restarts_from_the_start_block() {
    let a = long_chain(30, None, 0, None);
    let chain = FakeChain::from(&a);
    let ix = Indexer::new(chain.clone(), Arc::new(MemStore::new()), Arc::new(Shared::new(64, 5)), snap_cfg(100, 4, 0));
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    let mut b = Script::new();
    b.blocks.clear();
    b.blocks.push(mk_block(0, B256::ZERO, 9, 0, vec![])); // even genesis differs
    for i in 1..=32u64 {
        let p = b.blocks.last().unwrap().0.hash;
        b.blocks.push(mk_block(i, p, 9, 1_000 + i, vec![vec![]]));
    }
    chain.replace(&b);
    drain(&ix).await;
    assert!(ix.shared.chain.read().unwrap().halted.is_none());
    assert_eq!(ix.shared.state.read().unwrap().digest(), apply_script(&b).digest());
}

#[tokio::test]
async fn reorg_beyond_retained_block_hashes_halts_with_a_clear_reason() {
    let a = long_chain(60, None, 0, None);
    let chain = FakeChain::from(&a);
    let store = Arc::new(MemStore::new());
    let mut c = snap_cfg(100, 4, 0);
    c.block_retention = 10; // hashes older than tip-10 are pruned
    let ix = Indexer::new(chain.clone(), store, Arc::new(Shared::new(64, 5)), c);
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    let before = ix.shared.state.read().unwrap().digest();
    chain.replace(&long_chain(66, Some(20), 7, Some(&a)));
    assert!(ix.step().await.is_err());
    let h = ix.shared.chain.read().unwrap().halted.clone().expect("halted");
    assert!(h.contains("retained block-hash history"), "{h}");
    assert!(!ix.shared.is_ready());
    assert_eq!(ix.shared.state.read().unwrap().digest(), before, "state untouched when recovery is impossible");
}

// ------------------------------------------------------------------------------------------------ bounded fill window

#[test]
fn fill_window_is_bounded_and_the_newest_fills_survive() {
    let s = long_chain(40, None, 0, None);
    let mut full = State::new();
    full.apply_all(&s.all_events());
    let mut b = State::new();
    b.max_fills = 5;
    b.apply_all(&s.all_events());
    assert_eq!(full.fills.len(), 40);
    assert_eq!(b.fills.len(), 5, "memory holds only max_fills fills");
    assert_eq!(b.fills.iter().map(|f| f.trade_id).collect::<Vec<_>>(), vec![36, 37, 38, 39, 40]);
    assert_eq!(b.fills_evicted_key, Some(full.fills[34].key));
    assert_eq!(b.fills_by_market[&0].len(), 5);
    assert!(b.fills_by_acct.values().all(|v| v.len() <= 5));
    // everything else is unaffected by the window
    assert_eq!(b.positions, full.positions);
    assert_eq!(b.candles, full.candles);
    assert_eq!(b.markets, full.markets);
    // snapshot + tail == full replay also holds for the bounded window
    let mut head = State::new();
    head.max_fills = 5;
    head.apply_all(&s.blocks[..25].iter().flat_map(|x| x.1.clone()).collect::<Vec<_>>());
    let mut r = State::from_snapshot(&head.to_snapshot(), &head).unwrap();
    r.apply_all(&s.blocks[25..].iter().flat_map(|x| x.1.clone()).collect::<Vec<_>>());
    assert_eq!(r.digest(), b.digest());
}

async fn bounded_api(max_fills: usize, with_store: bool) -> axum::Router {
    let s = scenario();
    let store = Arc::new(MemStore::new());
    for (b, e) in &s.blocks {
        store.commit_block(b, e).await.unwrap();
    }
    let shared = prep_shared(max_fills);
    let mut app = App::new(
        shared,
        Arc::new(Security::local(SecurityCfg {
            ip_rps: 0.0,
            ..Default::default()
        })),
    );
    if with_store {
        app.store = Some(store);
    }
    router(app)
}

async fn all_pages(app: &axum::Router, base: &str, order: &str, limit: usize) -> Vec<serde_json::Value> {
    let mut out = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..200 {
        let sep = if base.contains('?') { '&' } else { '?' };
        let uri = format!(
            "{base}{sep}limit={limit}&order={order}{}",
            cursor.as_ref().map(|c| format!("&cursor={c}")).unwrap_or_default()
        );
        let (st, j) = get_json(app, &uri).await;
        assert_eq!(st, StatusCode::OK, "{uri}: {j}");
        out.extend(j["data"].as_array().unwrap().iter().cloned());
        match j["next_cursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => return out,
        }
    }
    panic!("pagination did not terminate");
}

#[tokio::test]
async fn trades_and_account_fills_older_than_the_window_come_from_postgres_with_identical_pagination() {
    let full = bounded_api(usize::MAX, false).await;
    let acct_hex = format!("{:#x}", acct(2));
    let uris = [
        "/v1/markets/0/trades".to_string(),
        format!("/v1/accounts/{acct_hex}/fills"),
        format!("/v1/accounts/{acct_hex}/fills?market=0"),
    ];
    assert!(apply_script(&scenario()).fills.len() > 2);
    for max in [1usize, 2] {
        let bounded = bounded_api(max, true).await;
        let (_, st) = get_json(&bounded, "/v1/status").await;
        assert_eq!(st["data"]["history"]["fills_in_memory"], max);
        assert_eq!(st["data"]["history"]["fills_older_served_from_postgres"], true);
        for u in &uris {
            for order in ["asc", "desc"] {
                for limit in [1usize, 2, 5, 1000] {
                    let want = all_pages(&full, u, order, limit).await;
                    let got = all_pages(&bounded, u, order, limit).await;
                    assert!(!want.is_empty());
                    assert_eq!(got, want, "max_fills={max} {u} order={order} limit={limit}");
                }
            }
        }
    }
    // without a store the bounded API can only serve the window (and says so in /v1/status)
    let no_store = bounded_api(2, false).await;
    assert_eq!(all_pages(&no_store, "/v1/markets/0/trades", "asc", 10).await.len(), 2);
}

// ------------------------------------------------------------------------------------------------ ADL price / raw logs

#[test]
fn adl_backstop_leg_uses_event_mark_price_when_present_and_a_bounded_estimate_otherwise() {
    // acct3 shorts 1 BTC to acct2 at 50k; acct2 is liquidated at mk (gap down), the backstop takes the long.
    // ADL then force-closes the profitable short (acct3): its leg at pT = mk + prem, the backstop sells at mk.
    let mk = 30_000 * PX;
    let prem: u64 = 7_500_000; // $7.5
    let size = BTC / 2;
    let pt = mk + prem;
    let debt = (size * prem as u128) / BTC;
    let setup = |mark_price: Option<u64>| {
        let mut s = Script::new();
        s.push(0, 1, vec![vec![accepted(1, 3, false, 50_000 * PX, BTC, 0), rested(1, BTC)]]);
        s.push(
            0,
            2,
            vec![vec![accepted(2, 2, true, 50_000 * PX, BTC, 1), fill(0, 1, 3, 2, true, 50_000 * PX, BTC)]],
        ); // acct2 long, acct3 short
        s.push(
            0,
            3,
            vec![vec![Ev::Liquidated {
                acct: acct(2),
                market: 0,
                keeper: Address::ZERO,
                size: BTC,
                price: mk,
                fee: 0,
                bad_debt: 1,
            }]],
        );
        s.push(
            0,
            4,
            vec![vec![Ev::AdlExecuted {
                target: acct(3),
                market: 0,
                size,
                price: pt,
                debt_cleared: debt,
                mark_price,
            }]],
        );
        apply_script(&s)
    };
    let est = setup(None);
    let exact = setup(Some(mk));
    let (be, bx) = (&est.positions[&(backstop_key(), 0)], &exact.positions[&(backstop_key(), 0)]);
    assert_eq!(
        adl_mark_estimate(false, pt, size, debt),
        mk,
        "estimate recovers the mark exactly when size divides evenly"
    );
    assert_eq!(
        (be.size, be.basis),
        (bx.size, bx.basis),
        "backstop size and basis are exact either way (reductions are price-independent)"
    );
    assert_eq!(be.size, (BTC - size) as i128);
    assert!(be.approximate && be.realized_pnl_error_bound == adl_pnl_error_bound(size));
    assert!(
        !bx.approximate && bx.realized_pnl_error_bound == 0,
        "no approximation flag once the event carries the mark"
    );
    assert_eq!(be.realized_pnl, bx.realized_pnl);
    // the target leg is exact: bought back at pT
    assert_eq!(est.positions[&(acct(3), 0)].size, -((BTC - size) as i128));
    // the estimate's pnl error never exceeds the documented bound, for awkward sizes/premiums
    for (sz, pr) in [
        (3 * BTC / 7, 12_345_679u64),
        (BTC / 100, 40_000_000),
        (123_456_789u128, 1_000_001),
        (10_000, 30_000_000),
    ] {
        let d = sz * pr as u128 / BTC;
        let e = adl_mark_estimate(true, 100 * PX, sz, d);
        let true_mk = 100 * PX + pr;
        let pnl_err = ((true_mk as i128 - e as i128).unsigned_abs() * sz) / BTC + 1;
        assert!(
            pnl_err <= adl_pnl_error_bound(sz),
            "size={sz} prem={pr}: pnl error {pnl_err} > bound {}",
            adl_pnl_error_bound(sz)
        );
    }
}

fn abi_with_adl_mark_price() -> String {
    let mut abi: serde_json::Value = serde_json::from_str(include_str!("../abi/PerpExchange.merged.json")).unwrap();
    for e in abi.as_array_mut().unwrap() {
        if e["type"] == "event" && e["name"] == "AdlExecuted" {
            e["inputs"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({"type":"uint64","name":"markPrice","indexed":false}));
        }
    }
    abi.to_string()
}

fn adl_v2_log(block: u64, li: u32) -> RawLog {
    use alloy_dyn_abi::DynSolValue as V;
    use alloy_primitives::U256;
    let ev = dec_event("AdlExecuted");
    let body = V::Tuple(vec![
        V::Uint(U256::from(BTC), 128),
        V::Uint(U256::from(29_992u64 * PX), 64),
        V::Uint(U256::from(7u64), 256),
        V::Uint(U256::from(30_000u64 * PX), 64),
    ]);
    RawLog {
        block,
        log_index: li,
        tx_hash: B256::repeat_byte(5),
        block_hash: B256::repeat_byte(6),
        topics: vec![ev.selector(), acct(1), B256::from(U256::from(0u64))],
        data: body.abi_encode_params(),
    }
}

fn dec_event(name: &str) -> alloy_json_abi::Event {
    let abi: alloy_json_abi::JsonAbi = serde_json::from_str(&abi_with_adl_mark_price()).unwrap();
    abi.events().find(|e| e.name == name).unwrap().clone()
}

#[tokio::test]
async fn unknown_events_are_stored_raw_and_re_derived_by_reindex_from_raw() {
    let old = Decoder::embedded().unwrap();
    let newer = Decoder::from_abi_json(&abi_with_adl_mark_price()).unwrap();
    let log = adl_v2_log(3, 0);
    // a contract upgrade added a field: the old decoder must not fail ingestion
    let rec = old.decode(&log, 99).unwrap();
    match &rec.ev {
        Ev::Other { name } => assert!(name.starts_with(UNKNOWN_PREFIX), "{name}"),
        o => panic!("expected Other, got {o:?}"),
    }
    assert_eq!(rec.raw.as_ref().unwrap().topics, log.topics, "raw topics kept");
    assert_eq!(rec.raw.as_ref().unwrap().data, log.data, "raw data kept");
    // undecodable payload for a *known* selector: stored as Other(Undecodable), not an error
    let known = Decoder::embedded().unwrap();
    let fill_sel = {
        let abi: alloy_json_abi::JsonAbi = serde_json::from_str(include_str!("../abi/PerpExchange.merged.json")).unwrap();
        abi.events().find(|e| e.name == "Fill").unwrap().selector()
    };
    let trunc = RawLog {
        topics: vec![fill_sel],
        data: vec![1, 2, 3],
        ..log.clone()
    };
    match known.decode(&trunc, 1).unwrap().ev {
        Ev::Other { name } => assert!(name.starts_with(UNDECODABLE_PREFIX), "{name}"),
        o => panic!("{o:?}"),
    }

    // persist the old-decoder result, reindex with the refreshed ABI
    let store = MemStore::new();
    store
        .commit_block(
            &BlockRef {
                number: 3,
                hash: B256::repeat_byte(6),
                parent_hash: B256::ZERO,
                ts: 99,
            },
            std::slice::from_ref(&rec),
        )
        .await
        .unwrap();
    store
        .save_snapshot(&crate::store::Snapshot {
            block: 3,
            block_hash: B256::repeat_byte(6),
            state: "x".into(),
        })
        .await
        .unwrap();
    let noop = crate::reindex::reindex_from_raw(&store, &old, 10).await.unwrap();
    assert_eq!((noop.scanned, noop.changed, noop.still_unknown), (1, 0, 1), "same ABI => nothing changes");
    assert_eq!(store.snapshot_blocks(), vec![3], "snapshots kept when nothing changed");
    let rep = crate::reindex::reindex_from_raw(&store, &newer, 10).await.unwrap();
    assert_eq!((rep.scanned, rep.changed, rep.still_unknown, rep.without_raw), (1, 1, 0, 0));
    assert!(store.snapshot_blocks().is_empty(), "snapshots dropped after re-deriving events");
    let got = store.load_events(None, 10).await.unwrap();
    match &got[0].ev {
        Ev::AdlExecuted {
            size,
            price,
            debt_cleared,
            mark_price,
            ..
        } => {
            assert_eq!((*size, *price, *debt_cleared, *mark_price), (BTC, 29_992 * PX, 7, Some(30_000 * PX)));
        }
        o => panic!("re-derived event is {o:?}"),
    }
    // idempotent
    assert_eq!(crate::reindex::reindex_from_raw(&store, &newer, 10).await.unwrap().changed, 0);
}

#[tokio::test]
async fn reindex_reports_rows_that_predate_raw_storage() {
    let s = scenario();
    let store = MemStore::new();
    for (b, e) in &s.blocks {
        store.commit_block(b, e).await.unwrap(); // raw: None, like rows written before this feature
    }
    let rep = crate::reindex::reindex_from_raw(&store, &Decoder::embedded().unwrap(), 7).await.unwrap();
    assert_eq!(rep.changed, 0);
    assert_eq!(rep.without_raw, rep.scanned);
    assert!(rep.scanned > 20);
}

// ------------------------------------------------------------------------------------------------ security

use axum::extract::ConnectInfo;
use std::net::SocketAddr;

fn sec_router(cfg: SecurityCfg, keys: Vec<crate::store::ApiKeyRec>) -> (axum::Router, Arc<Security>) {
    let shared = prep_shared(usize::MAX);
    let sec = Arc::new(Security::local(cfg));
    sec.set_keys(keys);
    (router(App::new(shared, sec.clone())), sec)
}

async fn send(app: &axum::Router, uri: &str, peer: &str, headers: &[(&str, &str)]) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
    let mut b = Request::builder().uri(uri);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let mut req = b.body(Body::empty()).unwrap();
    let sa: SocketAddr = format!("{peer}:4000").parse().unwrap();
    req.extensions_mut().insert(ConnectInfo(sa));
    let r = app.clone().oneshot(req).await.unwrap();
    let (st, h) = (r.status(), r.headers().clone());
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (st, h, serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null))
}

fn acao(h: &axum::http::HeaderMap) -> Option<String> {
    h.get("access-control-allow-origin").map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn cors_defaults_to_localhost_only_and_is_configurable() {
    let (app, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.0,
            ..Default::default()
        },
        vec![],
    );
    for (origin, allowed) in [
        ("http://localhost:3000", true),
        ("http://127.0.0.1:5173", true),
        ("https://evil.example", false),
        ("http://localhost.evil.example", false),
        ("null", false),
    ] {
        let (st, h, _) = send(&app, "/v1/status", "9.9.9.9", &[("origin", origin)]).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(acao(&h).as_deref(), allowed.then_some(origin), "origin {origin}");
    }
    let (_, h, _) = send(&app, "/v1/status", "9.9.9.9", &[]).await;
    assert_eq!(acao(&h), None, "no Origin => no CORS headers (and never a wildcard)");
    // preflight
    let mut req = Request::builder()
        .method("OPTIONS")
        .uri("/v1/status")
        .header("origin", "https://evil.example")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(ConnectInfo("9.9.9.9:1".parse::<SocketAddr>().unwrap()));
    let r = app.clone().oneshot(req).await.unwrap();
    assert!(
        r.headers().get("access-control-allow-origin").is_none(),
        "preflight from a foreign origin is not approved"
    );
    // configured origins
    let (app, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.0,
            cors_origins: vec!["https://app.example.com".into()],
            ..Default::default()
        },
        vec![],
    );
    let (_, h, _) = send(&app, "/v1/status", "9.9.9.9", &[("origin", "https://app.example.com")]).await;
    assert_eq!(acao(&h).as_deref(), Some("https://app.example.com"));
    assert!(h.get("access-control-allow-headers").unwrap().to_str().unwrap().contains("x-api-key"));
    let (_, h, _) = send(&app, "/v1/status", "9.9.9.9", &[("origin", "https://other.example.com")]).await;
    assert_eq!(acao(&h), None);
    let (app, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.0,
            cors_origins: vec!["*".into()],
            ..Default::default()
        },
        vec![],
    );
    let (_, h, _) = send(&app, "/v1/status", "9.9.9.9", &[("origin", "https://anything.example")]).await;
    assert_eq!(acao(&h).as_deref(), Some("*"));
}

#[test]
fn trusted_proxy_forwarded_for_handling() {
    let sec = Security::local(SecurityCfg {
        trusted_proxies: crate::security::parse_cidrs("10.0.0.0/8, 192.168.1.1").unwrap(),
        ..Default::default()
    });
    let ip = |s: &str| -> std::net::IpAddr { s.parse().unwrap() };
    // untrusted peer: header ignored (a client cannot choose its own bucket)
    assert_eq!(sec.client_ip(ip("8.8.8.8"), Some("1.2.3.4")), ip("8.8.8.8"));
    // trusted peer: the entry the proxy appended
    assert_eq!(sec.client_ip(ip("10.1.1.1"), Some("1.2.3.4")), ip("1.2.3.4"));
    // client-supplied junk on the left cannot override the proxy's entry
    assert_eq!(sec.client_ip(ip("10.1.1.1"), Some("6.6.6.6, 1.2.3.4")), ip("1.2.3.4"));
    // multi-hop: skip trusted proxies from the right
    assert_eq!(sec.client_ip(ip("10.1.1.1"), Some("1.2.3.4, 10.2.2.2, 192.168.1.1")), ip("1.2.3.4"));
    // malformed chain / missing header: fall back to the peer
    assert_eq!(sec.client_ip(ip("10.1.1.1"), Some("not-an-ip")), ip("10.1.1.1"));
    assert_eq!(sec.client_ip(ip("10.1.1.1"), None), ip("10.1.1.1"));
    // default config trusts nobody
    assert_eq!(
        Security::local(SecurityCfg::default()).client_ip(ip("10.1.1.1"), Some("1.2.3.4")),
        ip("10.1.1.1")
    );
}

#[tokio::test]
async fn per_ip_rate_limit_uses_forwarded_for_only_from_trusted_proxies() {
    let (app, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.001,
            ip_burst: 2.0,
            trusted_proxies: crate::security::parse_cidrs("10.0.0.1").unwrap(),
            ..Default::default()
        },
        vec![],
    );
    // behind the trusted proxy: two different end clients each get their own bucket of 2
    for client in ["1.1.1.1", "2.2.2.2"] {
        for i in 0..3 {
            let (st, h, j) = send(&app, "/v1/status", "10.0.0.1", &[("x-forwarded-for", client)]).await;
            if i < 2 {
                assert_eq!(st, StatusCode::OK, "{client} #{i}");
            } else {
                assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{client} #{i}");
                assert_eq!(j["code"], "rate_limited");
                assert!(h.contains_key("retry-after"));
            }
        }
    }
    // an untrusted peer cannot dodge its limit by rotating X-Forwarded-For
    let mut codes = vec![];
    for i in 0..4 {
        let xff = format!("7.7.7.{i}");
        codes.push(send(&app, "/v1/status", "5.5.5.5", &[("x-forwarded-for", &xff)]).await.0);
    }
    assert_eq!(
        codes,
        vec![StatusCode::OK, StatusCode::OK, StatusCode::TOO_MANY_REQUESTS, StatusCode::TOO_MANY_REQUESTS]
    );
}

fn test_key(label: &str, rps: Option<f64>, burst: Option<f64>) -> (crate::store::ApiKeyRec, String) {
    crate::security::generate_key(label, rps, burst, 1_700_000_000).unwrap()
}

#[tokio::test]
async fn api_keys_optional_required_invalid_and_revoked() {
    let (rec, key) = test_key("alice", None, None);
    // hashed at rest: neither the key nor its secret is in the stored record
    let secret = key.rsplit('_').next().unwrap();
    assert!(!format!("{rec:?}").contains(secret), "plaintext secret must not be stored: {rec:?}");
    assert_eq!(rec.hash, crate::security::hash_key(&key));
    assert!(key.starts_with(&format!("pk_{}_", rec.id)));

    // optional: anonymous works, a valid key works, a bad key is rejected (never silently downgraded)
    let (app, sec) = sec_router(
        SecurityCfg {
            ip_rps: 0.0,
            ..Default::default()
        },
        vec![rec.clone()],
    );
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[]).await.0, StatusCode::OK);
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &key)]).await.0, StatusCode::OK);
    assert_eq!(
        send(&app, "/v1/status", "9.9.9.9", &[("authorization", &format!("Bearer {key}"))]).await.0,
        StatusCode::OK
    );
    let wrong = format!("pk_{}_{}", rec.id, "0".repeat(48));
    let (st, _, j) = send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &wrong)]).await;
    assert_eq!((st, j["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("unauthorized")));
    assert_eq!(
        send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", "garbage")]).await.0,
        StatusCode::UNAUTHORIZED
    );

    // required
    let (app2, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.0,
            require_api_key: true,
            ..Default::default()
        },
        vec![rec.clone()],
    );
    let (st, _, j) = send(&app2, "/v1/status", "9.9.9.9", &[]).await;
    assert_eq!((st, j["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("api_key_required")));
    assert_eq!(send(&app2, "/v1/markets/0/trades", "9.9.9.9", &[("x-api-key", &key)]).await.0, StatusCode::OK);
    assert_eq!(send(&app2, "/healthz", "9.9.9.9", &[]).await.0, StatusCode::OK, "ops endpoints stay open");
    // read-only: keys cannot write
    let mut req = Request::builder()
        .method("POST")
        .uri("/v1/markets")
        .header("x-api-key", &key)
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(ConnectInfo("9.9.9.9:1".parse::<SocketAddr>().unwrap()));
    assert_eq!(app2.clone().oneshot(req).await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);

    // revoke => rejected after the table refresh
    let mut revoked = rec.clone();
    revoked.revoked_at = Some(5);
    sec.set_keys(vec![revoked]);
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &key)]).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn key_table_refresh_from_the_store_picks_up_creates_and_revokes() {
    let store = Arc::new(MemStore::new());
    let sec = Security::new(
        SecurityCfg::default(),
        Some(store.clone()),
        crate::ratelimit::Limiter::local("ip"),
        crate::ratelimit::Limiter::local("key"),
    );
    let (rec, key) = test_key("svc", Some(5.0), Some(7.0));
    assert!(sec.authenticate(&key).is_err());
    store.create_api_key(&rec).await.unwrap();
    assert_eq!(sec.refresh_keys().await.unwrap(), 1);
    let info = sec.authenticate(&key).unwrap();
    assert_eq!(
        (info.label.as_str(), info.rps, info.burst),
        ("svc", 5.0, 7.0),
        "per-key limits override the defaults"
    );
    assert!(store.revoke_api_key(&rec.id, 9).await.unwrap());
    assert!(!store.revoke_api_key(&rec.id, 10).await.unwrap(), "second revoke reports nothing to do");
    sec.refresh_keys().await.unwrap();
    assert!(sec.authenticate(&key).is_err());
}

#[tokio::test]
async fn per_key_limits_are_independent_of_the_ip_limit_and_of_other_keys() {
    let (k1, key1) = test_key("heavy", Some(0.001), Some(5.0));
    let (k2, key2) = test_key("other", Some(0.001), Some(1.0));
    let (app, _) = sec_router(
        SecurityCfg {
            ip_rps: 0.001,
            ip_burst: 1.0,
            ..Default::default()
        },
        vec![k1, k2],
    );
    // the anonymous IP bucket (burst 1) is exhausted after one request...
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[]).await.0, StatusCode::OK);
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[]).await.0, StatusCode::TOO_MANY_REQUESTS);
    // ...but the same IP with key1 has its own, larger bucket (5)
    let mut codes = vec![];
    for _ in 0..7 {
        codes.push(send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &key1)]).await.0.as_u16());
    }
    assert_eq!(codes, vec![200, 200, 200, 200, 200, 429, 429]);
    // key2 (burst 1) is unaffected by key1 being limited
    assert_eq!(send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &key2)]).await.0, StatusCode::OK);
    assert_eq!(
        send(&app, "/v1/status", "9.9.9.9", &[("x-api-key", &key2)]).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let (_, _, j) = send(&app, "/v1/status", "1.2.3.4", &[("x-api-key", &key2)]).await;
    assert_eq!(j["code"], "rate_limited", "a key is limited wherever it is used from");
}

fn spawn_redis() -> Option<(std::process::Child, u16)> {
    let bin = ["/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server", "/usr/bin/redis-server"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())?;
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let child = std::process::Command::new(bin)
        .args(["--port", &port.to_string(), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .ok()?;
    Some((child, port))
}

#[tokio::test]
async fn redis_backed_limiter_shares_state_between_replicas_and_falls_back_when_down() {
    use crate::ratelimit::Limiter;
    use crate::redis::RedisClient;
    let Some((mut child, port)) = spawn_redis() else {
        eprintln!("SKIPPED redis test: redis-server not installed");
        return;
    };
    let url = format!("redis://127.0.0.1:{port}");
    let r = Arc::new(RedisClient::from_url(&url).unwrap());
    let mut up = false;
    for _ in 0..50 {
        if r.ping().await.is_ok() {
            up = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(up, "redis-server did not start");
    // two independent "replicas" (separate Limiter instances/connections) share one bucket
    let a = Limiter::with_redis("rl", Arc::new(RedisClient::from_url(&url).unwrap()));
    let b = Limiter::with_redis("rl", Arc::new(RedisClient::from_url(&url).unwrap()));
    assert!(a.is_shared());
    assert!(a.check("ip:1.1.1.1", 0.001, 3.0).await.is_ok());
    assert!(b.check("ip:1.1.1.1", 0.001, 3.0).await.is_ok());
    assert!(a.check("ip:1.1.1.1", 0.001, 3.0).await.is_ok());
    let retry = b
        .check("ip:1.1.1.1", 0.001, 3.0)
        .await
        .expect_err("fourth token must be refused across replicas");
    assert!(retry >= 1);
    assert!(a.check("ip:2.2.2.2", 0.001, 3.0).await.is_ok(), "other keys independent");
    assert_eq!(a.backend_errors.load(std::sync::atomic::Ordering::Relaxed), 0);
    // refill is time based (rate 50/s => ~20ms per token)
    for _ in 0..3 {
        let _ = a.check("ip:3.3.3.3", 50.0, 1.0).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert!(b.check("ip:3.3.3.3", 50.0, 1.0).await.is_ok());
    // redis goes away: requests are still served from the in-memory bucket and the failure is counted
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(a.check("ip:4.4.4.4", 0.001, 1.0).await.is_ok());
    assert!(a.check("ip:4.4.4.4", 0.001, 1.0).await.is_err(), "local fallback still limits");
    assert!(a.backend_errors.load(std::sync::atomic::Ordering::Relaxed) >= 2);
}

#[test]
fn redis_url_parsing() {
    use crate::redis::RedisClient;
    assert!(RedisClient::from_url("redis://localhost").is_ok());
    assert!(RedisClient::from_url("redis://:secret@10.0.0.2:6380/3").is_ok());
    assert!(RedisClient::from_url("rediss://localhost").is_err(), "TLS is explicitly unsupported");
    assert!(RedisClient::from_url("http://x").is_err());
}

// ------------------------------------------------------------------------------------------------ tx tracker

#[tokio::test]
async fn tx_tracker_records_receipt_statuses_including_reverted_and_reorged_out() {
    use crate::indexer::ReceiptInfo;
    use crate::store::TrackedTx;
    use crate::tracker::TxTracker;
    struct Chain(Mutex<Option<ReceiptInfo>>);
    #[async_trait]
    impl ChainSource for Chain {
        async fn head(&self) -> anyhow::Result<u64> {
            Ok(100)
        }
        async fn header(&self, _n: u64) -> anyhow::Result<Option<BlockRef>> {
            Ok(None)
        }
        async fn events(&self, _f: u64, _t: u64, _ts: &HashMap<u64, u64>) -> anyhow::Result<Vec<EventRecord>> {
            Ok(vec![])
        }
        async fn rpc_finalized(&self) -> Option<u64> {
            None
        }
        async fn receipt(&self, _tx: B256) -> anyhow::Result<Option<ReceiptInfo>> {
            Ok(self.0.lock().unwrap().clone())
        }
    }
    let chain = Arc::new(Chain(Mutex::new(None)));
    let store = Arc::new(MemStore::new());
    let h = B256::repeat_byte(0xab);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    assert!(store.track_tx(h, now, 10).await.unwrap());
    assert!(!store.track_tx(h, 2, 10).await.unwrap(), "idempotent");
    let tr = TxTracker {
        chain: chain.clone(),
        store: store.clone(),
        timeout_secs: 3600,
        recheck_depth: 50,
    };
    tr.check_once().await.unwrap();
    assert_eq!(store.get_tracked_tx(h).await.unwrap().unwrap().status, "pending");
    *chain.0.lock().unwrap() = Some(ReceiptInfo {
        success: false,
        block_number: 95,
        block_hash: B256::repeat_byte(1),
        gas_used: 21_000,
    });
    tr.check_once().await.unwrap();
    let t: TrackedTx = store.get_tracked_tx(h).await.unwrap().unwrap();
    assert_eq!((t.status.as_str(), t.block_number, t.gas_used), ("reverted", Some(95), Some(21_000)));
    *chain.0.lock().unwrap() = Some(ReceiptInfo {
        success: true,
        block_number: 96,
        block_hash: B256::repeat_byte(2),
        gas_used: 50_000,
    });
    tr.check_once().await.unwrap();
    assert_eq!(store.get_tracked_tx(h).await.unwrap().unwrap().status, "success");
    // the block is reorged out: receipt disappears => back to pending
    *chain.0.lock().unwrap() = None;
    tr.check_once().await.unwrap();
    let t = store.get_tracked_tx(h).await.unwrap().unwrap();
    assert_eq!((t.status.as_str(), t.block_number), ("pending", None));
    // never seen within the timeout => dropped
    let tr2 = TxTracker { timeout_secs: -1, ..tr };
    tr2.check_once().await.unwrap();
    assert_eq!(store.get_tracked_tx(h).await.unwrap().unwrap().status, "dropped");
    // capacity bound
    let s2 = MemStore::new();
    s2.track_tx(B256::repeat_byte(1), 1, 1).await.unwrap();
    assert!(s2.track_tx(B256::repeat_byte(2), 1, 1).await.is_err());
}

#[tokio::test]
async fn tx_track_endpoints_are_opt_in() {
    let shared = prep_shared(usize::MAX);
    let sec = Arc::new(Security::local(SecurityCfg {
        ip_rps: 0.0,
        ..Default::default()
    }));
    let mut app = App::new(shared, sec);
    let off = router(app.clone());
    let post = |app: &axum::Router, body: &str| {
        let mut req = Request::builder()
            .method("POST")
            .uri("/v1/tx/track")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo("9.9.9.9:1".parse::<SocketAddr>().unwrap()));
        let app = app.clone();
        async move {
            let r = app.oneshot(req).await.unwrap();
            let st = r.status();
            let b = r.into_body().collect().await.unwrap().to_bytes();
            (st, serde_json::from_slice::<serde_json::Value>(&b).unwrap_or_default())
        }
    };
    let h = format!("{:#x}", B256::repeat_byte(0x11));
    let (st, j) = post(&off, &format!("{{\"tx_hash\":\"{h}\"}}")).await;
    assert_eq!((st, j["code"].as_str()), (StatusCode::NOT_FOUND, Some("not_found")), "disabled by default");
    app.store = Some(Arc::new(MemStore::new()));
    app.tx_tracking = true;
    let on = router(app);
    let (st, j) = post(&on, &format!("{{\"tx_hash\":\"{h}\"}}")).await;
    assert_eq!(st, StatusCode::OK, "{j}");
    assert_eq!(j["data"]["status"], "pending");
    let (st, j) = get_json(&on, &format!("/v1/tx/{h}")).await;
    assert_eq!((st, j["data"]["status"].as_str()), (StatusCode::OK, Some("pending")));
    assert_eq!(post(&on, "{\"tx_hash\":\"0x12\"}").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(get_json(&on, &format!("/v1/tx/{:#x}", B256::repeat_byte(0x22))).await.0, StatusCode::NOT_FOUND);
}

// ------------------------------------------------------------------------------------------------ JSON-RPC batching

#[tokio::test]
async fn header_fetching_uses_json_rpc_batches_and_stops_at_the_first_unknown_block() {
    use crate::indexer::RpcChain;
    use crate::rpc::Rpc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let reqs = Arc::new(AtomicUsize::new(0));
    let max_batch = Arc::new(AtomicUsize::new(0));
    let (r2, m2) = (reqs.clone(), max_batch.clone());
    let app = axum::Router::new().route(
        "/",
        axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
            let (r2, m2) = (r2.clone(), m2.clone());
            async move {
                r2.fetch_add(1, Ordering::SeqCst);
                let one = |v: &serde_json::Value| {
                    let n = u64::from_str_radix(v["params"][0].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
                    let result = if n >= 100 {
                        serde_json::Value::Null // chain head is 99
                    } else {
                        serde_json::json!({"number": format!("0x{n:x}"), "hash": format!("0x{:064x}", n + 1), "parentHash": format!("0x{:064x}", n), "timestamp": format!("0x{:x}", 1000 + n)})
                    };
                    serde_json::json!({"jsonrpc":"2.0","id":v["id"],"result":result})
                };
                axum::Json(match &body {
                    serde_json::Value::Array(a) => {
                        m2.fetch_max(a.len(), Ordering::SeqCst);
                        serde_json::Value::Array(a.iter().map(one).collect())
                    }
                    o => one(o),
                })
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let mk = |batch: usize, conc: usize| {
        let mut c = RpcChain::new(
            Rpc::new(&format!("http://127.0.0.1:{port}/")).unwrap(),
            "0x0000000000000000000000000000000000000001".into(),
            Decoder::embedded().unwrap(),
        );
        c.batch_size = batch;
        c.concurrency = conc;
        c
    };
    let c = mk(50, 4);
    let hs = c.headers(0, 119).await.unwrap();
    assert_eq!(hs.len(), 100, "stops at the first unknown block");
    assert!(hs
        .iter()
        .enumerate()
        .all(|(i, h)| h.number == i as u64 && h.parent_hash == B256::from(alloy_primitives::U256::from(i as u64)) && h.ts == 1000 + i as u64));
    assert_eq!(reqs.load(Ordering::SeqCst), 3, "120 headers => 3 batch requests of <= 50, not 120 requests");
    assert_eq!(max_batch.load(Ordering::SeqCst), 50);
    reqs.store(0, Ordering::SeqCst);
    let c1 = mk(1, 1);
    assert_eq!(c1.headers(0, 29).await.unwrap().len(), 30);
    assert_eq!(reqs.load(Ordering::SeqCst), 30, "batch size 1 = legacy one request per block");
}

// ------------------------------------------------------------------------------------------------ PostgreSQL integration
// Run with TEST_DATABASE_URL="host=localhost user=$USER dbname=postgres" (each test gets its own schema).
// Skipped (printed) when the variable is not set.

async fn pg_store(name: &str) -> Option<(crate::store::PgStore, String, String)> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    let schema = format!("ut_{name}_{}", std::process::id());
    let admin = crate::store::PgStore::connect(&url).await.unwrap();
    drop(admin);
    let st = crate::store::PgStore::connect_schema(&url, Some(&schema)).await.unwrap();
    st.init(31337, "0xabc").await.unwrap();
    Some((st, url, schema))
}

async fn pg_drop(url: &str, schema: &str) {
    let (c, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(conn);
    c.batch_execute(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).await.unwrap();
}

#[tokio::test]
async fn postgres_store_contract_raw_snapshots_fills_keys_and_tracked_txs() {
    let Some((st, url, schema)) = pg_store("contract").await else {
        eprintln!("SKIPPED postgres test: TEST_DATABASE_URL not set");
        return;
    };
    let s = scenario();
    // attach raw payloads to every event so the column round trip is exercised
    let with_raw = |recs: &[EventRecord]| -> Vec<EventRecord> {
        recs.iter()
            .map(|r| EventRecord {
                raw: Some(RawData {
                    topics: vec![B256::repeat_byte(r.meta.log_index as u8 + 1), acct(7)],
                    data: vec![r.meta.log_index as u8, 0xff, 0],
                }),
                ..r.clone()
            })
            .collect()
    };
    for (b, e) in &s.blocks {
        st.commit_block(b, &with_raw(e)).await.unwrap();
    }
    assert_eq!(st.commit_block(&s.blocks[3].0, &with_raw(&s.blocks[3].1)).await.unwrap(), 0, "idempotent");
    let want = with_raw(&s.all_events());
    let got = st.load_events_raw(None, 1000).await.unwrap();
    assert_eq!(got, want, "decoded + raw round trip");
    assert!(st.load_events(None, 1000).await.unwrap().iter().all(|r| r.raw.is_none()));
    assert_eq!(st.load_events(Some(want[3].meta.key()), 2).await.unwrap().len(), 2);
    // hash-chain walking beyond any window
    let bb = st.blocks_before(6, 3).await.unwrap();
    assert_eq!(bb.iter().map(|b| b.number).collect::<Vec<_>>(), vec![5, 4, 3]);
    assert_eq!(st.oldest_block().await.unwrap().unwrap().number, 0);
    assert_eq!(st.tip().await.unwrap().unwrap().number, s.blocks.len() as u64 - 1);

    // fills_page == reducer fills (incl. taker_order_id) for every filter/direction
    let full = apply_script(&s);
    let all: Vec<FillRow> = full.fills.iter().cloned().collect();
    assert!(all.len() >= 2, "{} fills", all.len());
    let q = |market, acct_, lo, hi, limit, desc| crate::store::FillQuery {
        market,
        acct: acct_,
        lo_excl: lo,
        hi_incl: hi,
        limit,
        desc,
    };
    assert_eq!(st.fills_page(&q(None, None, None, None, 100, false)).await.unwrap(), all);
    let mut rev = all.clone();
    rev.reverse();
    assert_eq!(st.fills_page(&q(Some(0), None, None, None, 100, true)).await.unwrap(), rev);
    assert_eq!(st.fills_page(&q(None, None, None, None, 2, false)).await.unwrap(), all[..2].to_vec());
    assert_eq!(
        st.fills_page(&q(None, None, Some(all[0].key), Some(all[2].key), 100, false)).await.unwrap(),
        all[1..=2].to_vec()
    );
    let a2: Vec<FillRow> = all.iter().filter(|f| f.maker == acct(2) || f.taker == acct(2)).cloned().collect();
    assert_eq!(st.fills_page(&q(None, Some(acct(2)), None, None, 100, false)).await.unwrap(), a2);
    assert_eq!(st.fills_page(&q(Some(9), None, None, None, 100, false)).await.unwrap(), vec![]);
    assert!(all.iter().any(|f| f.taker_order_id.is_some()), "taker order ids are derived");

    // snapshots: save, latest-at-or-below, prune, rollback invalidates
    for b in [2u64, 4, 6] {
        st.save_snapshot(&crate::store::Snapshot {
            block: b,
            block_hash: s.blocks[b as usize].0.hash,
            state: format!("s{b}"),
        })
        .await
        .unwrap();
    }
    assert_eq!(st.latest_snapshot(5).await.unwrap().unwrap().block, 4);
    assert_eq!(st.latest_snapshot(1).await.unwrap().map(|x| x.block), None);
    st.prune_snapshots(2).await.unwrap();
    assert_eq!(st.latest_snapshot(3).await.unwrap().map(|x| x.block), None, "oldest pruned");
    assert!(st.rollback_after(Some(5)).await.unwrap() > 0);
    assert_eq!(
        st.latest_snapshot(100).await.unwrap().unwrap().block,
        4,
        "snapshot@6 deleted by the rollback to 5"
    );
    assert_eq!(st.tip().await.unwrap().unwrap().number, 5);

    // update_decoded
    let mut changed = want[0].clone();
    changed.ev = Ev::Other { name: "Rewritten".into() };
    assert_eq!(st.update_decoded(&[changed]).await.unwrap(), 1);
    assert_eq!(st.load_events(None, 1).await.unwrap()[0].ev, Ev::Other { name: "Rewritten".into() });

    // api keys
    let (rec, key) = test_key("pg", Some(3.0), None);
    st.create_api_key(&rec).await.unwrap();
    let l = st.list_api_keys().await.unwrap();
    assert_eq!(l.len(), 1);
    assert_eq!((l[0].hash.as_str(), l[0].rps, l[0].burst), (rec.hash.as_str(), Some(3.0), None));
    assert!(!l[0].hash.contains(key.rsplit('_').next().unwrap()));
    assert!(st.revoke_api_key(&rec.id, 7).await.unwrap());
    assert_eq!(st.list_api_keys().await.unwrap()[0].revoked_at, Some(7));

    // tracked txs
    let h = B256::repeat_byte(3);
    assert!(st.track_tx(h, 10, 5).await.unwrap());
    assert!(!st.track_tx(h, 11, 5).await.unwrap());
    let mut t = st.get_tracked_tx(h).await.unwrap().unwrap();
    assert_eq!((t.status.as_str(), t.submitted_at), ("pending", 10));
    t.status = "reverted".into();
    t.block_number = Some(9);
    t.block_hash = Some(B256::repeat_byte(4));
    t.gas_used = Some(21000);
    st.update_tracked_tx(&t).await.unwrap();
    assert_eq!(st.get_tracked_tx(h).await.unwrap().unwrap(), t);
    assert_eq!(st.txs_to_check(5, 10).await.unwrap().len(), 1, "recent confirmed receipts are re-checked");
    assert_eq!(st.txs_to_check(50, 10).await.unwrap().len(), 0);
    // wipe keeps keys, drops the log
    st.wipe().await.unwrap();
    st.init(31337, "0xabc").await.unwrap();
    assert!(st.tip().await.unwrap().is_none());
    assert_eq!(st.list_api_keys().await.unwrap().len(), 1);
    pg_drop(&url, &schema).await;
}

#[tokio::test]
async fn postgres_backed_indexer_snapshots_restart_reorg_and_raw_reindex() {
    let Some((st, url, schema)) = pg_store("indexer").await else {
        eprintln!("SKIPPED postgres test: TEST_DATABASE_URL not set");
        return;
    };
    let store: Arc<dyn EventStore> = Arc::new(st);
    let a = long_chain(45, None, 0, None);
    let chain = FakeChain::from(&a);
    let ix = Indexer::new(chain.clone(), store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(8, 8, 10));
    ix.bootstrap().await.unwrap();
    drain(&ix).await;
    assert_eq!(store.latest_snapshot(45).await.unwrap().unwrap().block, 40);
    let ix2 = Indexer::new(chain.clone(), store.clone(), Arc::new(Shared::new(64, 5)), snap_cfg(8, 8, 10));
    ix2.bootstrap().await.unwrap();
    assert_eq!(
        crate::shared::Metrics::get(&ix2.shared.metrics.last_replay_events),
        5 * EV_PER_BLOCK,
        "PG restart replays only the tail"
    );
    assert_eq!(ix2.shared.state.read().unwrap().digest(), apply_script(&a).digest());
    // deep reorg (window 8, depth 25)
    let b = long_chain(50, Some(20), 3, Some(&a));
    chain.replace(&b);
    drain(&ix).await;
    assert!(ix.shared.chain.read().unwrap().alert.is_some());
    assert_eq!(ix.shared.state.read().unwrap().digest(), apply_script(&b).digest());
    pg_drop(&url, &schema).await;
}
