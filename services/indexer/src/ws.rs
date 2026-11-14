//! `/v1/ws` websocket endpoint. See docs/ws-schemas.md for the protocol.
use crate::api::{parse_acct, App};
use crate::hub::{book_snapshot_msg, Sub, CLOSE_PROTOCOL, CLOSE_SLOW_CONSUMER};
use crate::shared::Metrics;
use crate::state::Interval;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxState;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;

const MAX_CLIENT_MSG: usize = 4096;
const PING_EVERY: Duration = Duration::from_secs(20);

pub async fn ws_handler(AxState(app): AxState<App>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_CLIENT_MSG).on_upgrade(move |sock| client(app, sock))
}

#[derive(Deserialize)]
struct ClientMsg {
    op: String,
    channel: Option<String>,
    market: Option<u8>,
    interval: Option<String>,
    acct: Option<String>,
    sub: Option<u8>,
}

fn sub_of(m: &ClientMsg) -> Result<Sub, (&'static str, String)> {
    let ch = m.channel.as_deref().ok_or(("invalid_argument", "channel required".to_string()))?;
    let market = || m.market.ok_or(("invalid_argument", "market required".to_string()));
    let acct = || {
        let a = m.acct.as_deref().ok_or(("invalid_argument", "acct required".to_string()))?;
        parse_acct(a, m.sub.map(|s| s.to_string()).as_deref()).map_err(|e| ("invalid_argument", e.message))
    };
    Ok(match ch {
        "book" => Sub::Book(market()?),
        "trades" => Sub::Trades(market()?),
        "candles" => {
            let iv = Interval::parse(m.interval.as_deref().unwrap_or("1m")).ok_or(("invalid_argument", "interval must be 1m, 5m or 1h".to_string()))?;
            Sub::Candles(market()?, iv)
        }
        "orders" => Sub::Orders(acct()?),
        "fills" => Sub::Fills(acct()?),
        _ => {
            return Err((
                "unknown_channel",
                format!("unknown channel {ch}; expected book, trades, candles, orders, fills"),
            ))
        }
    })
}

fn err(code: &str, message: &str) -> String {
    json!({"type":"error","code":code,"message":message}).to_string()
}

async fn client(app: App, sock: WebSocket) {
    Metrics::inc(&app.shared.metrics.ws_accepted);
    let hub = &app.shared.hub;
    let mut h = hub.register();
    let id = h.id;
    let (mut tx, mut rx) = sock.split();
    let slow = h.slow.clone();

    // writer: drains the bounded queue; when the hub drops us for being slow, close with a dedicated code.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                m = h.rx.recv() => match m {
                    Some(m) => { if tx.send(Message::Text(m.to_string().into())).await.is_err() { break; } }
                    None => {
                        let (code, reason) = if slow.load(Ordering::SeqCst) { (CLOSE_SLOW_CONSUMER, "slow consumer: queue overflow, reconnect and resnapshot") } else { (1001, "going away") };
                        let _ = tx.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                        break;
                    }
                },
                _ = ping.tick() => { if tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; } }
            }
        }
    });

    while let Some(Ok(msg)) = rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Binary(_) => {
                hub.send_direct(id, err("invalid_argument", "binary frames are not supported"));
                continue;
            }
        };
        let m: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                hub.send_direct(id, err("invalid_argument", &format!("malformed message: {e}")));
                continue;
            }
        };
        match m.op.as_str() {
            "ping" => hub.send_direct(id, json!({"type":"pong"}).to_string()),
            "subscribe" | "resnapshot" | "unsubscribe" => match sub_of(&m) {
                Err((c, e)) => hub.send_direct(id, err(c, &e)),
                Ok(sub) => match m.op.as_str() {
                    "unsubscribe" => {
                        hub.unsubscribe(id, &sub);
                        hub.send_direct(id, json!({"type":"unsubscribed","channel":m.channel}).to_string());
                    }
                    "resnapshot" => match sub {
                        Sub::Book(mk) => {
                            // hold the state read lock so no delta can slip between the snapshot and the queue
                            let st = app.shared.state.read().unwrap();
                            hub.send_direct(id, book_snapshot_msg(&st, mk));
                        }
                        _ => hub.send_direct(id, err("invalid_argument", "resnapshot is only defined for the book channel")),
                    },
                    _ => {
                        let ack = json!({"type":"subscribed","channel":m.channel,"market":m.market,"interval":m.interval,"acct":m.acct}).to_string();
                        hub.send_direct(id, ack);
                        let r = if let Sub::Book(mk) = sub {
                            let st = app.shared.state.read().unwrap();
                            hub.subscribe(id, sub, Some(book_snapshot_msg(&st, mk)))
                        } else {
                            hub.subscribe(id, sub, None)
                        };
                        if let Err(e) = r {
                            hub.send_direct(id, err(e, "subscription rejected"));
                        }
                    }
                },
            },
            other => hub.send_direct(id, err("unknown_op", &format!("unknown op {other}"))),
        }
    }
    let _ = CLOSE_PROTOCOL;
    hub.unregister(id);
    // let the writer flush a pending close frame, then stop it
    let _ = tokio::time::timeout(Duration::from_millis(200), writer).await;
}
