// Records REAL indexer responses (REST + a few WS frames) into src/lib/data/fixtures/ for the unit tests.
// The OpenAPI spec carries no example payloads, so recorded live payloads are the fixtures. Run after scripts/activity.mjs.
// Usage: node scripts/capture-fixtures.mjs   (IDX=http://127.0.0.1:18648)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { account, acctKey, ex, order, usd, btc, TIF } from "./lib.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "../src/lib/data/fixtures");
const IDX = process.env.IDX ?? "http://127.0.0.1:18648";
const key = acctKey(account(1).address, 0);
const save = (n, j) => fs.writeFileSync(path.join(out, `${n}.json`), JSON.stringify(j, null, 2) + "\n");
const get = async (p) => (await fetch(`${IDX}/v1${p}`)).json();
const paths = {
  status: "/status", markets: "/markets", "book": "/markets/0/book?depth=5", trades: "/markets/0/trades?limit=3", candles: "/markets/0/candles?interval=1m&limit=5",
  "market-funding": "/markets/0/funding", orders: `/accounts/${key}/orders?limit=10`, fills: `/accounts/${key}/fills?limit=5`, positions: `/accounts/${key}/positions?include_closed=true`,
  "account-funding": `/accounts/${key}/funding`, transfers: `/accounts/${key}/transfers`, twaps: `/accounts/${key}/twaps`, conditionals: `/accounts/${key}/conditionals`,
  liquidations: `/liquidations?acct=${key}`, "bad-debt": "/bad-debt", "error-404": "/markets/99",
};
for (const [n, p] of Object.entries(paths)) save(n, await get(p));
// WS: subscribe, then cause a book change + a trade, record every frame
const frames = [];
const ws = new WebSocket(IDX.replace(/^http/, "ws") + "/v1/ws");
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => frames.push(JSON.parse(e.data));
for (const s of [{ channel: "book", market: 0 }, { channel: "trades", market: 0 }]) ws.send(JSON.stringify({ op: "subscribe", ...s }));
await new Promise((r) => setTimeout(r, 600));
const me = account(1).address;
await ex(1, "placeOrder", [me, 0, order({ market: 0, isBuy: false, price: usd(50200), size: btc(0.02) })]); // rests -> delta
await ex(1, "placeOrder", [me, 0, order({ market: 0, isBuy: true, price: usd(50050), size: btc(0.01), tif: TIF.IOC })]); // trade + delta(s)
await new Promise((r) => setTimeout(r, 1200));
ws.close();
save("ws-frames", frames);
console.log("saved", Object.keys(paths).length, "REST fixtures and", frames.length, "ws frames");
