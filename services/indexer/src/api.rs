//! Versioned REST API (`/v1`). Read-only; derived data only (never authoritative for balances).
use crate::security::{AuthError, Security};
use crate::shared::{Metrics, Shared};
use crate::state::*;
use crate::store::{EventStore, FillQuery};
use crate::ws::ws_handler;
use alloy_primitives::{Address, B256};
use axum::extract::{ConnectInfo, Path, Query, Request, State as AxState};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub const DISCLAIMER: &str = "Derived from chain events by an unaudited indexer. Never authoritative for balances or margin: verify against the contract.";

#[derive(Clone)]
pub struct App {
    pub shared: Arc<Shared>,
    pub security: Arc<Security>,
    /// Persistent log: serves fills older than the in-memory window and the opt-in tx tracker.
    pub store: Option<Arc<dyn EventStore>>,
    /// Opt-in `/v1/tx/track` receipt tracker (see `tracker.rs`).
    pub tx_tracking: bool,
    pub tx_track_max_pending: usize,
}

impl App {
    pub fn new(shared: Arc<Shared>, security: Arc<Security>) -> Self {
        Self {
            shared,
            security,
            store: None,
            tx_tracking: false,
            tx_track_max_pending: 10_000,
        }
    }
}

// ------------------------------------------------------------------------------------------------ errors

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_argument",
            message: msg.into(),
        }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: msg.into(),
        }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: msg.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"code": self.code, "message": self.message}))).into_response()
    }
}

type R = Result<Json<Value>, ApiError>;

// ------------------------------------------------------------------------------------------------ params

struct P(HashMap<String, String>);

impl P {
    fn limit(&self) -> Result<usize, ApiError> {
        match self.0.get("limit") {
            None => Ok(100),
            Some(s) => {
                let n: usize = s.parse().map_err(|_| ApiError::invalid("limit must be an integer"))?;
                if n == 0 || n > 1000 {
                    return Err(ApiError::invalid("limit must be in 1..=1000"));
                }
                Ok(n)
            }
        }
    }
    fn cursor(&self) -> Result<Option<u128>, ApiError> {
        match self.0.get("cursor") {
            None => Ok(None),
            Some(s) => u128::from_str_radix(s, 16).map(Some).map_err(|_| ApiError::invalid("malformed cursor")),
        }
    }
    /// newest-first by default
    fn desc(&self) -> Result<bool, ApiError> {
        match self.0.get("order").map(|s| s.as_str()) {
            None | Some("desc") => Ok(true),
            Some("asc") => Ok(false),
            Some(_) => Err(ApiError::invalid("order must be asc or desc")),
        }
    }
    fn u64(&self, k: &str) -> Result<Option<u64>, ApiError> {
        self.0
            .get(k)
            .map(|s| s.parse::<u64>().map_err(|_| ApiError::invalid(format!("{k} must be an unsigned integer"))))
            .transpose()
    }
    fn market(&self) -> Result<Option<u8>, ApiError> {
        self.0
            .get("market")
            .map(|s| s.parse::<u8>().map_err(|_| ApiError::invalid("market must be 0..=255")))
            .transpose()
    }
}

pub fn parse_acct(s: &str, sub: Option<&str>) -> Result<B256, ApiError> {
    let t = s.strip_prefix("0x").unwrap_or(s);
    match t.len() {
        64 => s
            .parse::<B256>()
            .or_else(|_| format!("0x{t}").parse::<B256>())
            .map_err(|_| ApiError::invalid("malformed account key")),
        40 => {
            let a: Address = format!("0x{t}").parse().map_err(|_| ApiError::invalid("malformed address"))?;
            let sub: u8 = sub
                .map(|x| x.parse().map_err(|_| ApiError::invalid("sub must be 0..=255")))
                .transpose()?
                .unwrap_or(0);
            Ok(acct_key(a, sub))
        }
        _ => Err(ApiError::invalid(
            "account must be a 32-byte account key or a 20-byte owner address (with optional ?sub=)",
        )),
    }
}

fn pid8(s: &str) -> Result<u8, ApiError> {
    s.parse().map_err(|_| ApiError::invalid("market id must be an integer in 0..=255"))
}
fn pid64(s: &str) -> Result<u64, ApiError> {
    s.parse().map_err(|_| ApiError::invalid("id must be an unsigned integer"))
}

fn acct_from(path: &str, p: &P) -> Result<B256, ApiError> {
    parse_acct(path, p.0.get("sub").map(|s| s.as_str()))
}

fn indexed_block(app: &App) -> Option<u64> {
    app.shared.chain.read().unwrap().indexed.as_ref().map(|b| b.number)
}

fn one(app: &App, data: Value) -> R {
    Ok(Json(json!({"data": data, "indexed_block": indexed_block(app)})))
}

fn many<T: Serialize>(app: &App, rows: Vec<&T>, next: Option<u128>) -> R {
    Ok(Json(
        json!({"data": rows, "next_cursor": next.map(|k| format!("{k:x}")), "indexed_block": indexed_block(app)}),
    ))
}

// ------------------------------------------------------------------------------------------------ handlers

async fn status(AxState(app): AxState<App>) -> R {
    let c = app.shared.chain.read().unwrap().clone();
    let lag = app.shared.lag();
    let (events, reorgs, fills_in_mem, fills_evicted) = {
        let st = app.shared.state.read().unwrap();
        (
            st.counters.applied,
            Metrics::get(&app.shared.metrics.reorgs),
            st.fills.len(),
            st.fills_evicted_key.is_some(),
        )
    };
    Ok(Json(json!({"data": {
        "schema_version": 1,
        "chain_id": c.chain_id,
        "exchange": c.exchange,
        "indexed_head": c.indexed.as_ref().map(|b| json!({"number": b.number, "hash": b.hash, "timestamp": b.ts})),
        "chain_head": c.chain_head,
        "lag_blocks": lag,
        "synced": app.shared.is_ready(),
        "halted": c.halted,
        "alert": c.alert,
        "history": {
            "fills_in_memory": fills_in_mem,
            "fills_older_served_from_postgres": fills_evicted,
            "last_replay_events": Metrics::get(&app.shared.metrics.last_replay_events),
        },
        // Execution as observed from the RPC node's latest block. NOT final on the parent chain.
        "canonical_execution": {
            "source": "rpc_latest",
            "block": c.chain_head,
            "timestamp": c.chain_head_ts,
            "note": "latest block as executed by the L2 node; subject to reorg until the node's own reorg window has passed"
        },
        // The indexer does not read parent-chain batch posting / challenge-period state.
        "parent_chain_finality": {
            "status": "unknown",
            "reason": "not available: local/dev chain has no parent chain, and this indexer does not read batch posting or finality data",
            "block": null
        },
        "rpc_finalized_block": c.rpc_finalized,
        "events_indexed": events,
        "reorgs_handled": reorgs,
        "disclaimer": DISCLAIMER,
    }})))
}

fn market_view(st: &State, id: u8) -> Value {
    let m = st.markets.get(&id).cloned().unwrap_or(MarketRow { id, ..Default::default() });
    let meta = st.meta.get(&id).cloned();
    let (v24, qv24, hi, lo, open) = st.stats_24h(id);
    let mut v = serde_json::to_value(&m).unwrap();
    let o = v.as_object_mut().unwrap();
    o.insert("state_name".into(), json!(market_state_name(m.state)));
    o.insert("name".into(), json!(meta.as_ref().and_then(|x| x.name.clone())));
    o.insert("config".into(), serde_json::to_value(&meta).unwrap());
    o.insert(
        "stats_24h".into(),
        json!({"volume_base": v24.to_string(), "volume_quote": qv24.to_string(), "high": hi.map(|x| x.to_string()), "low": lo.map(|x| x.to_string()), "open": open.map(|x| x.to_string())}),
    );
    v
}

fn market_ids(st: &State) -> Vec<u8> {
    let mut ids: Vec<u8> = st.markets.keys().chain(st.meta.keys()).copied().collect();
    ids.sort();
    ids.dedup();
    ids
}

async fn markets(AxState(app): AxState<App>) -> R {
    let st = app.shared.state.read().unwrap();
    let data: Vec<Value> = market_ids(&st).into_iter().map(|id| market_view(&st, id)).collect();
    drop(st);
    one(&app, json!(data))
}

fn known_market(st: &State, id: u8) -> Result<(), ApiError> {
    if market_ids(st).contains(&id) {
        Ok(())
    } else {
        Err(ApiError::not_found(format!("unknown market {id}")))
    }
}

async fn market(AxState(app): AxState<App>, Path(id): Path<String>) -> R {
    let id = pid8(&id)?;
    let st = app.shared.state.read().unwrap();
    known_market(&st, id)?;
    let v = market_view(&st, id);
    drop(st);
    one(&app, v)
}

async fn book(AxState(app): AxState<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let id = pid8(&id)?;
    let p = P(q);
    let depth = p.u64("depth")?.unwrap_or(50);
    if depth == 0 || depth > 1000 {
        return Err(ApiError::invalid("depth must be in 1..=1000"));
    }
    let st = app.shared.state.read().unwrap();
    known_market(&st, id)?;
    let (seq, bids, asks) = st.book_snapshot(id, depth as usize);
    drop(st);
    let lv = |v: Vec<(u64, u128)>| -> Vec<Value> { v.into_iter().map(|(p, s)| json!([p.to_string(), s.to_string()])).collect() };
    one(
        &app,
        json!({"market": id, "seq": seq, "bids": lv(bids), "asks": lv(asks), "levels": "[price, size] as decimal strings; bids high->low, asks low->high"}),
    )
}

enum FillScope {
    Market(u8),
    Acct(B256, Option<u8>),
}

/// The in-memory part of a fills page: up to `limit` rows and whether more exist in memory beyond them.
fn mem_fills(st: &State, scope: &FillScope, cursor: Option<u128>, limit: usize, desc: bool) -> (Vec<FillRow>, bool) {
    let empty = VecDeque::new();
    let (idxs, market) = match scope {
        FillScope::Market(m) => (st.fills_by_market.get(m).unwrap_or(&empty), None),
        FillScope::Acct(a, m) => (st.fills_by_acct.get(a).unwrap_or(&empty), *m),
    };
    let pg = page_idx(
        idxs.len(),
        |i| st.fill_abs(idxs[i]).key,
        cursor,
        limit,
        desc,
        |i| market.is_none_or(|m| st.fill_abs(idxs[i]).market == m),
    );
    (pg.idx.iter().map(|i| st.fill_abs(idxs[*i]).clone()).collect(), pg.next.is_some())
}

/// One page of fills: the newest ones from the bounded in-memory window, older ones (below `fills_evicted_key`) from
/// the Postgres event log. Cursor semantics are identical either way (key of the last row seen).
async fn fills_paged(app: &App, scope: FillScope, cursor: Option<u128>, limit: usize, desc: bool) -> Result<(Vec<FillRow>, Option<u128>), ApiError> {
    let (market, acct) = match &scope {
        FillScope::Market(m) => (Some(*m), None),
        FillScope::Acct(a, m) => (*m, Some(*a)),
    };
    let evicted = app.shared.state.read().unwrap().fills_evicted_key;
    let db = |lo: Option<u128>, hi: Option<u128>, n: usize, desc: bool| {
        let store = app.store.clone();
        let q = FillQuery {
            market,
            acct,
            lo_excl: lo,
            hi_incl: hi,
            limit: n,
            desc,
        };
        async move {
            match store {
                Some(s) => s.fills_page(&q).await.map_err(|e| ApiError::internal(format!("history lookup failed: {e:#}"))),
                None => Ok(vec![]),
            }
        }
    };
    let snap = |cursor: Option<u128>, n: usize| {
        let st = app.shared.state.read().unwrap();
        mem_fills(&st, &scope, cursor, n, desc)
    };
    let key_of = |v: &[FillRow]| v.last().map(|f| f.key);
    if desc {
        let (mut rows, mem_more) = snap(cursor, limit);
        if mem_more || evicted.is_none() || app.store.is_none() {
            let next = if mem_more { key_of(&rows) } else { None };
            return Ok((rows, next));
        }
        let e = evicted.unwrap();
        let need = limit - rows.len();
        let hi = e.min(cursor.map_or(u128::MAX, |c| c.saturating_sub(1)));
        let mut older = db(None, Some(hi), need + 1, true).await?;
        let more = older.len() > need;
        older.truncate(need);
        rows.extend(older);
        let next = if more { key_of(&rows) } else { None };
        Ok((rows, next))
    } else {
        let use_db = app.store.is_some() && evicted.is_some_and(|e| cursor.is_none_or(|c| c < e));
        if !use_db {
            let (rows, more) = snap(cursor, limit);
            let next = if more { key_of(&rows) } else { None };
            return Ok((rows, next));
        }
        let e = evicted.unwrap();
        let mut rows = db(cursor, Some(e), limit + 1, false).await?;
        if rows.len() > limit {
            rows.truncate(limit);
            let next = key_of(&rows);
            return Ok((rows, next));
        }
        let remaining = limit - rows.len();
        let (mem, mem_more) = snap(None, remaining.max(1));
        if remaining == 0 {
            let next = if mem.is_empty() { None } else { key_of(&rows) };
            return Ok((rows, next));
        }
        rows.extend(mem);
        let next = if mem_more { key_of(&rows) } else { None };
        Ok((rows, next))
    }
}

async fn market_trades(AxState(app): AxState<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let id = pid8(&id)?;
    let p = P(q);
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    known_market(&app.shared.state.read().unwrap(), id)?;
    let (rows, next) = fills_paged(&app, FillScope::Market(id), cursor, limit, desc).await?;
    many(&app, rows.iter().collect(), next)
}

async fn candles(AxState(app): AxState<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let id = pid8(&id)?;
    let p = P(q);
    let iv = Interval::parse(p.0.get("interval").map(|s| s.as_str()).unwrap_or("1m")).ok_or_else(|| ApiError::invalid("interval must be one of 1m, 5m, 1h"))?;
    let from = p.u64("from")?.unwrap_or(0);
    let to = p.u64("to")?.unwrap_or(u64::MAX);
    let limit = match p.0.get("limit") {
        None => 500usize,
        Some(s) => {
            let n: usize = s.parse().map_err(|_| ApiError::invalid("limit must be an integer"))?;
            if n == 0 || n > 5000 {
                return Err(ApiError::invalid("limit must be in 1..=5000"));
            }
            n
        }
    };
    if from > to {
        return Err(ApiError::invalid("from must be <= to"));
    }
    let st = app.shared.state.read().unwrap();
    known_market(&st, id)?;
    let mut rows: Vec<&Candle> = match st.candles.get(&(id, iv)) {
        Some(m) => m.range(from..=to).map(|(_, c)| c).collect(),
        None => vec![],
    };
    // the most recent `limit` candles of the window, oldest first
    if rows.len() > limit {
        rows = rows.split_off(rows.len() - limit);
    }
    let data = json!({"market": id, "interval": iv.name(), "candles": rows});
    drop(st);
    one(&app, data)
}

async fn market_funding(AxState(app): AxState<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let id = pid8(&id)?;
    let p = P(q);
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let st = app.shared.state.read().unwrap();
    known_market(&st, id)?;
    let pg = page_idx(
        st.funding_updates.len(),
        |i| st.funding_updates[i].key,
        cursor,
        limit,
        desc,
        |i| st.funding_updates[i].market == id,
    );
    let rows: Vec<&FundingUpdateRow> = pg.idx.iter().map(|i| &st.funding_updates[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn account_orders(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let status =
        p.0.get("status")
            .map(|s| OrderStatus::parse(s).ok_or_else(|| ApiError::invalid("unknown status")))
            .transpose()?;
    let market = p.market()?;
    let st = app.shared.state.read().unwrap();
    let empty = vec![];
    let ids = st.orders_by_acct.get(&a).unwrap_or(&empty);
    let pg = page_idx(
        ids.len(),
        |i| ids[i] as u128,
        cursor,
        limit,
        desc,
        |i| {
            let o = &st.orders[&ids[i]];
            status.is_none_or(|s| o.status == s) && market.is_none_or(|m| o.market == m)
        },
    );
    let rows: Vec<&OrderRow> = pg.idx.iter().map(|i| &st.orders[&ids[*i]]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn account_fills(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let market = p.market()?;
    let (fills, next) = fills_paged(&app, FillScope::Acct(a, market), cursor, limit, desc).await?;
    let rows: Vec<Value> = fills
        .iter()
        .map(|f| {
            let mut v = serde_json::to_value(f).unwrap();
            let role = if f.maker == a && f.taker == a {
                "both"
            } else if f.maker == a {
                "maker"
            } else {
                "taker"
            };
            v.as_object_mut().unwrap().insert("role".into(), json!(role));
            v
        })
        .collect();
    many_values(&app, rows, next)
}

fn many_values(app: &App, rows: Vec<Value>, next: Option<u128>) -> R {
    Ok(Json(
        json!({"data": rows, "next_cursor": next.map(|k| format!("{k:x}")), "indexed_block": indexed_block(app)}),
    ))
}

async fn account_positions(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let include_closed = p.0.get("include_closed").map(|s| s == "true").unwrap_or(false);
    let st = app.shared.state.read().unwrap();
    let rows: Vec<&PositionRow> = st
        .positions
        .range((a, 0)..=(a, u8::MAX))
        .map(|(_, v)| v)
        .filter(|r| include_closed || r.size != 0)
        .collect();
    let data = json!(rows);
    drop(st);
    one(&app, data)
}

async fn account_funding(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let st = app.shared.state.read().unwrap();
    let empty = vec![];
    let idxs = st.funding_settles_by_acct.get(&a).unwrap_or(&empty);
    let pg = page_idx(idxs.len(), |i| st.funding_settles[idxs[i] as usize].key, cursor, limit, desc, |_| true);
    let rows: Vec<&FundingSettleRow> = pg.idx.iter().map(|i| &st.funding_settles[idxs[*i] as usize]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

fn transfers_inner(app: &App, acct: Option<B256>, p: &P) -> R {
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let kind = p.0.get("kind").cloned();
    if let Some(k) = &kind {
        if !["deposit", "withdraw", "internal_transfer", "iso_margin"].contains(&k.as_str()) {
            return Err(ApiError::invalid("kind must be deposit, withdraw, internal_transfer or iso_margin"));
        }
    }
    let st = app.shared.state.read().unwrap();
    let empty = vec![];
    let out = match acct {
        Some(a) => {
            let idxs = st.transfers_by_acct.get(&a).unwrap_or(&empty);
            let pg = page_idx(
                idxs.len(),
                |i| st.transfers[idxs[i] as usize].key,
                cursor,
                limit,
                desc,
                |i| kind.as_deref().is_none_or(|k| st.transfers[idxs[i] as usize].kind == k),
            );
            let rows: Vec<&TransferRow> = pg.idx.iter().map(|i| &st.transfers[idxs[*i] as usize]).collect();
            many(app, rows, pg.next)
        }
        None => {
            let pg = page_idx(
                st.transfers.len(),
                |i| st.transfers[i].key,
                cursor,
                limit,
                desc,
                |i| kind.as_deref().is_none_or(|k| st.transfers[i].kind == k),
            );
            let rows: Vec<&TransferRow> = pg.idx.iter().map(|i| &st.transfers[*i]).collect();
            many(app, rows, pg.next)
        }
    };
    drop(st);
    out
}

async fn account_transfers(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    transfers_inner(&app, Some(a), &p)
}

async fn all_transfers(AxState(app): AxState<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    transfers_inner(&app, None, &p)
}

async fn account_twaps(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let st = app.shared.state.read().unwrap();
    let all: Vec<&TwapRow> = st.twaps.values().filter(|t| t.acct == a).collect();
    let pg = page_idx(all.len(), |i| all[i].id as u128, cursor, limit, desc, |_| true);
    let rows: Vec<&TwapRow> = pg.idx.iter().map(|i| all[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn account_conds(AxState(app): AxState<App>, Path(acct): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let a = acct_from(&acct, &p)?;
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let st = app.shared.state.read().unwrap();
    let all: Vec<&CondRow> = st.conds.values().filter(|t| t.acct == a).collect();
    let pg = page_idx(all.len(), |i| all[i].id as u128, cursor, limit, desc, |_| true);
    let rows: Vec<&CondRow> = pg.idx.iter().map(|i| all[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn order_by_id(AxState(app): AxState<App>, Path(id): Path<String>) -> R {
    let id = pid64(&id)?;
    let st = app.shared.state.read().unwrap();
    let o = st.orders.get(&id).ok_or_else(|| ApiError::not_found(format!("order {id} not found")))?;
    let v = serde_json::to_value(o).unwrap();
    drop(st);
    one(&app, v)
}

async fn twap_by_id(AxState(app): AxState<App>, Path(id): Path<String>) -> R {
    let id = pid64(&id)?;
    let st = app.shared.state.read().unwrap();
    let t = st.twaps.get(&id).ok_or_else(|| ApiError::not_found(format!("twap {id} not found")))?;
    let v = serde_json::to_value(t).unwrap();
    drop(st);
    one(&app, v)
}

async fn cond_by_id(AxState(app): AxState<App>, Path(id): Path<String>) -> R {
    let id = pid64(&id)?;
    let st = app.shared.state.read().unwrap();
    let t = st
        .conds
        .get(&id)
        .ok_or_else(|| ApiError::not_found(format!("conditional order {id} not found")))?;
    let v = serde_json::to_value(t).unwrap();
    drop(st);
    one(&app, v)
}

async fn liquidations(AxState(app): AxState<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let market = p.market()?;
    let acct = p.0.get("acct").map(|s| parse_acct(s, p.0.get("sub").map(|x| x.as_str()))).transpose()?;
    let st = app.shared.state.read().unwrap();
    let pg = page_idx(
        st.liquidations.len(),
        |i| st.liquidations[i].key,
        cursor,
        limit,
        desc,
        |i| {
            let l = &st.liquidations[i];
            market.is_none_or(|m| l.market == m) && acct.is_none_or(|a| l.acct == a)
        },
    );
    let rows: Vec<&LiquidationRow> = pg.idx.iter().map(|i| &st.liquidations[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn bad_debt(AxState(app): AxState<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let market = p.market()?;
    let st = app.shared.state.read().unwrap();
    let pg = page_idx(
        st.bad_debt.len(),
        |i| st.bad_debt[i].key,
        cursor,
        limit,
        desc,
        |i| market.is_none_or(|m| st.bad_debt[i].market == Some(m)),
    );
    let rows: Vec<&BadDebtRow> = pg.idx.iter().map(|i| &st.bad_debt[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

async fn backstop_events(AxState(app): AxState<App>, Query(q): Query<HashMap<String, String>>) -> R {
    let p = P(q);
    let (limit, cursor, desc) = (p.limit()?, p.cursor()?, p.desc()?);
    let market = p.market()?;
    let kind = p.0.get("kind").map(|s| s.as_str());
    let st = app.shared.state.read().unwrap();
    let pg = page_idx(
        st.backstop.len(),
        |i| st.backstop[i].key,
        cursor,
        limit,
        desc,
        |i| market.is_none_or(|m| st.backstop[i].market == Some(m)) && kind.is_none_or(|k| st.backstop[i].kind == k),
    );
    let rows: Vec<&BackstopRow> = pg.idx.iter().map(|i| &st.backstop[*i]).collect();
    let out = many(&app, rows, pg.next);
    drop(st);
    out
}

/// Event-derived backstop Phase 2 state per market (last `BackstopCfgSet`, elevated/relaxed flag, take counts) plus the global
/// place-open flag and take fee. Live inventory / auction price are NOT here: read `backstopAuction(market)` from the chain.
async fn backstop_state(AxState(app): AxState<App>) -> R {
    let st = app.shared.state.read().unwrap();
    let mut mk: std::collections::BTreeMap<u8, Value> = std::collections::BTreeMap::new();
    let (mut place_open, mut take_fee) = (Value::Null, Value::Null);
    for r in &st.backstop {
        let e = r.market.map(|m| mk.entry(m).or_insert_with(|| json!({"market": m, "elevated": false, "elevated_notional": null, "cfg": null, "takes": 0, "unwinds": 0})));
        match r.kind {
            "backstop_cfg_set" => {
                e.unwrap()["cfg"] = json!({"soft_notional": r.soft_notional, "max_disc_bps": r.max_disc_bps, "dwell": r.dwell, "ramp": r.ramp, "max_age": r.max_age, "block": r.block});
            }
            "backstop_elevated" => {
                let e = e.unwrap();
                e["elevated"] = json!(true);
                e["elevated_notional"] = json!(r.notional);
            }
            "backstop_relaxed" => {
                let e = e.unwrap();
                e["elevated"] = json!(false);
                e["elevated_notional"] = Value::Null;
            }
            "backstop_taken" => {
                let e = e.unwrap();
                e["takes"] = json!(e["takes"].as_u64().unwrap_or(0) + 1);
            }
            "backstop_unwound" => {
                let e = e.unwrap();
                e["unwinds"] = json!(e["unwinds"].as_u64().unwrap_or(0) + 1);
            }
            "backstop_place_open_set" => place_open = json!(r.open),
            "backstop_take_fee_set" => take_fee = json!(r.bps),
            _ => {}
        }
    }
    let markets: Vec<Value> = mk.into_values().collect();
    drop(st);
    one(&app, json!({"markets": markets, "place_open": place_open, "take_fee_bps": take_fee}))
}

// ------------------------------------------------------------------------------------------------ ops endpoints

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz(AxState(app): AxState<App>) -> Response {
    if app.shared.is_ready() {
        (StatusCode::OK, Json(json!({"status": "ready", "lag_blocks": app.shared.lag()}))).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code": "not_ready", "message": format!("indexer not synced (lag_blocks={:?}, max={})", app.shared.lag(), app.shared.ready_max_lag)})),
        )
            .into_response()
    }
}

async fn metrics(AxState(app): AxState<App>) -> Response {
    let m = &app.shared.metrics;
    let c = app.shared.chain.read().unwrap().clone();
    let mut s = String::new();
    let mut g = |name: &str, help: &str, kind: &str, v: String| {
        s.push_str(&format!("# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {v}\n"));
    };
    g(
        "indexer_head_block",
        "Highest indexed block",
        "gauge",
        c.indexed.as_ref().map(|b| b.number).unwrap_or(0).to_string(),
    );
    g(
        "indexer_chain_head_block",
        "Latest chain head seen",
        "gauge",
        c.chain_head.unwrap_or(0).to_string(),
    );
    g(
        "indexer_lag_blocks",
        "Chain head minus indexed head",
        "gauge",
        app.shared.lag().unwrap_or(0).to_string(),
    );
    g(
        "indexer_ready",
        "1 if /readyz would return 200",
        "gauge",
        (app.shared.is_ready() as u8).to_string(),
    );
    g(
        "indexer_blocks_indexed_total",
        "Blocks committed",
        "counter",
        Metrics::get(&m.blocks_indexed).to_string(),
    );
    g("indexer_reorgs_total", "Reorgs handled", "counter", Metrics::get(&m.reorgs).to_string());
    g(
        "indexer_last_reorg_depth",
        "Depth of the most recent reorg",
        "gauge",
        Metrics::get(&m.last_reorg_depth).to_string(),
    );
    g(
        "indexer_rpc_errors_total",
        "Failed indexer steps",
        "counter",
        Metrics::get(&m.rpc_errors).to_string(),
    );
    g(
        "indexer_deep_reorgs_total",
        "Reorgs deeper than the reorg window that were re-anchored (operator alert)",
        "counter",
        Metrics::get(&m.deep_reorgs).to_string(),
    );
    g(
        "indexer_alert_active",
        "1 if a sticky operator alert is set (see /v1/status.data.alert)",
        "gauge",
        (c.alert.is_some() as u8).to_string(),
    );
    g(
        "indexer_halted",
        "1 if indexing is halted and needs operator action",
        "gauge",
        (c.halted.is_some() as u8).to_string(),
    );
    g(
        "indexer_snapshots_saved_total",
        "Read-model snapshots persisted",
        "counter",
        Metrics::get(&m.snapshots_saved).to_string(),
    );
    g(
        "indexer_last_replay_events",
        "Events replayed by the last read-model rebuild (startup or reorg)",
        "gauge",
        Metrics::get(&m.last_replay_events).to_string(),
    );
    g(
        "indexer_last_replay_snapshot_block_plus_one",
        "1 + block of the snapshot the last rebuild started from (0 = full replay)",
        "gauge",
        Metrics::get(&m.last_replay_snapshot_block).to_string(),
    );
    g(
        "http_unauthorized_total",
        "Requests rejected with 401",
        "counter",
        Metrics::get(&m.unauthorized).to_string(),
    );
    g(
        "http_rate_limited_ip_total",
        "429s from the per-IP limiter",
        "counter",
        Metrics::get(&m.rate_limited_ip).to_string(),
    );
    g(
        "http_rate_limited_key_total",
        "429s from the per-API-key limiter",
        "counter",
        Metrics::get(&m.rate_limited_key).to_string(),
    );
    g(
        "rate_limit_backend_errors_total",
        "Redis rate-limiter failures that fell back to the in-memory bucket",
        "counter",
        (app.security.ip_limiter.backend_errors.load(Ordering::Relaxed) + app.security.key_limiter.backend_errors.load(Ordering::Relaxed)).to_string(),
    );
    g(
        "rate_limit_shared",
        "1 if rate limits are shared through Redis",
        "gauge",
        (app.security.ip_limiter.is_shared() as u8).to_string(),
    );
    g("http_requests_total", "HTTP requests", "counter", Metrics::get(&m.http_requests).to_string());
    g("http_responses_2xx_total", "2xx responses", "counter", Metrics::get(&m.http_2xx).to_string());
    g("http_responses_4xx_total", "4xx responses", "counter", Metrics::get(&m.http_4xx).to_string());
    g("http_responses_5xx_total", "5xx responses", "counter", Metrics::get(&m.http_5xx).to_string());
    g(
        "http_rate_limited_total",
        "Requests rejected with 429",
        "counter",
        Metrics::get(&m.rate_limited).to_string(),
    );
    g("ws_clients", "Connected websocket clients", "gauge", app.shared.hub.client_count().to_string());
    g(
        "ws_accepted_total",
        "Websocket connections accepted",
        "counter",
        Metrics::get(&m.ws_accepted).to_string(),
    );
    g(
        "ws_dropped_slow_total",
        "Websocket clients dropped for being slow",
        "counter",
        app.shared.hub.dropped_slow.load(Ordering::Relaxed).to_string(),
    );
    {
        let st = app.shared.state.read().unwrap();
        g(
            "indexer_events_applied_total",
            "Events applied to read models",
            "counter",
            st.counters.applied.to_string(),
        );
        g(
            "indexer_duplicate_events_skipped_total",
            "Duplicate events ignored",
            "counter",
            st.counters.duplicates_skipped.to_string(),
        );
        g(
            "indexer_unknown_refs_total",
            "Events referencing unseen orders/twaps (start block after creation?)",
            "counter",
            st.counters.unknown_refs.to_string(),
        );
        g(
            "indexer_overflow_total",
            "128-bit saturations in derived math",
            "counter",
            st.counters.overflow.to_string(),
        );
        g(
            "indexer_undecoded_events_total",
            "Logs stored as Other because the embedded ABI cannot decode them (refresh the ABI + reindex-from-raw)",
            "counter",
            st.counters.undecoded.to_string(),
        );
        g(
            "indexer_fills_in_memory",
            "Fills held in the bounded in-memory window",
            "gauge",
            st.fills.len().to_string(),
        );
        s.push_str("# HELP indexer_events_total Events applied by name\n# TYPE indexer_events_total counter\n");
        for (n, v) in &st.counters.by_name {
            s.push_str(&format!("indexer_events_total{{event=\"{n}\"}} {v}\n"));
        }
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], s).into_response()
}

async fn not_found() -> ApiError {
    ApiError::not_found("no such route")
}

async fn method_not_allowed() -> ApiError {
    ApiError {
        status: StatusCode::METHOD_NOT_ALLOWED,
        code: "method_not_allowed",
        message: "this API is read-only (GET); the only write is POST /v1/tx/track when the tx tracker is enabled".into(),
    }
}

// ------------------------------------------------------------------------------------------------ middleware

fn json_error(status: StatusCode, code: &str, message: String) -> Response {
    (status, Json(json!({"code": code, "message": message}))).into_response()
}

fn presented_key(req: &Request) -> Option<String> {
    let h = req.headers();
    if let Some(v) = h.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.trim().to_string());
    }
    h.get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(|v| v.trim().to_string())
}

async fn guard(AxState(app): AxState<App>, req: Request, next: Next) -> Response {
    let m = &app.shared.metrics;
    let sec = &app.security;
    Metrics::inc(&m.http_requests);
    let path = req.uri().path().to_string();
    let ops = matches!(path.as_str(), "/healthz" | "/readyz" | "/metrics");
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(String::from);
    let allow_origin = origin.as_deref().and_then(|o| sec.cors_header(o));
    let tx_methods = app.tx_tracking;
    // CORS: only echo allowed origins; never a blanket `*` unless the operator configured it.
    let cors = move |mut r: Response| {
        let h = r.headers_mut();
        if let Some(a) = &allow_origin {
            if let Ok(v) = HeaderValue::from_str(a) {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            }
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(if tx_methods { "GET, POST, OPTIONS" } else { "GET, OPTIONS" }),
            );
            h.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("content-type, x-api-key, authorization"),
            );
        }
        h.append(header::VARY, HeaderValue::from_static("Origin"));
        r
    };
    if req.method() == Method::OPTIONS {
        return cors(StatusCode::NO_CONTENT.into_response());
    }
    if !ops {
        let peer: IpAddr = req
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::from([127, 0, 0, 1]));
        let xff = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok());
        let ip = sec.client_ip(peer, xff);
        // authentication: a presented key must be valid even when keys are optional
        let key = match presented_key(&req) {
            Some(k) => match sec.authenticate(&k) {
                Ok(info) => Some(info),
                Err(AuthError::Missing | AuthError::Invalid) => {
                    Metrics::inc(&m.unauthorized);
                    Metrics::inc(&m.http_4xx);
                    return cors(json_error(StatusCode::UNAUTHORIZED, "unauthorized", "invalid or revoked API key".into()));
                }
            },
            None if sec.cfg.require_api_key => {
                Metrics::inc(&m.unauthorized);
                Metrics::inc(&m.http_4xx);
                return cors(json_error(
                    StatusCode::UNAUTHORIZED,
                    "api_key_required",
                    "an API key is required (X-API-Key header or Authorization: Bearer)".into(),
                ));
            }
            None => None,
        };
        // rate limit: per key when authenticated, otherwise per client IP
        let verdict = match &key {
            Some(k) => sec.key_limiter.check(&k.id.to_string(), k.rps, k.burst).await.map_err(|r| (r, true)),
            None => sec
                .ip_limiter
                .check(&ip.to_string(), sec.cfg.ip_rps, sec.cfg.ip_burst)
                .await
                .map_err(|r| (r, false)),
        };
        if let Err((retry, by_key)) = verdict {
            Metrics::inc(&m.rate_limited);
            Metrics::inc(if by_key { &m.rate_limited_key } else { &m.rate_limited_ip });
            Metrics::inc(&m.http_4xx);
            let mut r = json_error(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                format!("rate limit exceeded ({}); retry in {retry}s", if by_key { "per API key" } else { "per IP" }),
            );
            r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(retry));
            return cors(r);
        }
    }
    let resp = next.run(req).await;
    match resp.status().as_u16() {
        200..=299 | 101 => Metrics::inc(&m.http_2xx),
        400..=499 => Metrics::inc(&m.http_4xx),
        500..=599 => Metrics::inc(&m.http_5xx),
        _ => {}
    }
    cors(resp)
}

// ------------------------------------------------------------------------------------------------ tx tracker

#[derive(serde::Deserialize)]
struct TrackReq {
    tx_hash: String,
}

fn tx_json(t: &crate::store::TrackedTx) -> Value {
    json!({
        "tx_hash": t.tx_hash,
        "status": t.status,
        "submitted_at": t.submitted_at,
        "checked_at": t.checked_at,
        "block_number": t.block_number,
        "block_hash": t.block_hash,
        "gas_used": t.gas_used.map(|x| x.to_string()),
        "note": "receipt-based status. A reverted transaction emits no contract events, so it never appears in any other endpoint. `dropped` means no receipt was seen within the timeout; it can still land later (then the status updates).",
    })
}

fn tracker_store(app: &App) -> Result<Arc<dyn EventStore>, ApiError> {
    match (&app.store, app.tx_tracking) {
        (Some(s), true) => Ok(s.clone()),
        _ => Err(ApiError::not_found(
            "transaction tracking is disabled (start the indexer with --enable-tx-tracker)",
        )),
    }
}

async fn tx_track(AxState(app): AxState<App>, Json(req): Json<TrackReq>) -> R {
    let store = tracker_store(&app)?;
    let h: B256 = req.tx_hash.parse().map_err(|_| ApiError::invalid("tx_hash must be a 32-byte hex hash"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    store
        .track_tx(h, now, app.tx_track_max_pending)
        .await
        .map_err(|e| ApiError::invalid(format!("{e:#}")))?;
    Metrics::inc(&app.shared.metrics.tracked_txs);
    let t = store.get_tracked_tx(h).await.map_err(|e| ApiError::internal(format!("{e:#}")))?;
    one(&app, t.map(|t| tx_json(&t)).unwrap_or(Value::Null))
}

async fn tx_status(AxState(app): AxState<App>, Path(hash): Path<String>) -> R {
    let store = tracker_store(&app)?;
    let h: B256 = hash.parse().map_err(|_| ApiError::invalid("tx hash must be a 32-byte hex hash"))?;
    match store.get_tracked_tx(h).await.map_err(|e| ApiError::internal(format!("{e:#}")))? {
        Some(t) => one(&app, tx_json(&t)),
        None => Err(ApiError::not_found("transaction is not tracked; POST /v1/tx/track first")),
    }
}

pub fn router(app: App) -> Router {
    let v1 = Router::new()
        .route("/status", get(status))
        .route("/markets", get(markets))
        .route("/markets/{market}", get(market))
        .route("/markets/{market}/book", get(book))
        .route("/markets/{market}/trades", get(market_trades))
        .route("/markets/{market}/candles", get(candles))
        .route("/markets/{market}/funding", get(market_funding))
        .route("/accounts/{acct}/orders", get(account_orders))
        .route("/accounts/{acct}/fills", get(account_fills))
        .route("/accounts/{acct}/positions", get(account_positions))
        .route("/accounts/{acct}/funding", get(account_funding))
        .route("/accounts/{acct}/transfers", get(account_transfers))
        .route("/accounts/{acct}/twaps", get(account_twaps))
        .route("/accounts/{acct}/conditionals", get(account_conds))
        .route("/orders/{id}", get(order_by_id))
        .route("/twaps/{id}", get(twap_by_id))
        .route("/conditionals/{id}", get(cond_by_id))
        .route("/liquidations", get(liquidations))
        .route("/bad-debt", get(bad_debt))
        .route("/backstop/events", get(backstop_events))
        .route("/backstop/state", get(backstop_state))
        .route("/transfers", get(all_transfers))
        .route("/tx/track", post(tx_track).layer(axum::extract::DefaultBodyLimit::max(1024)))
        .route("/tx/{hash}", get(tx_status))
        .route("/ws", get(ws_handler));
    Router::new()
        .nest("/v1", v1)
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}
