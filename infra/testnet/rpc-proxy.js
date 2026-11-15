// Tiny local HTTP -> HTTPS JSON-RPC forwarder for the read-only testnet services (indexer, keeper). Reason: the Rust indexer binary is built
// without TLS ("invalid URL, scheme is not http"), so it cannot talk to https RPC endpoints directly. This proxy also retries 429/5xx with backoff.
// Holds no key. UPSTREAM_RPC_URL (default the public Arbitrum Sepolia RPC; set your own provider URL in your shell, never commit it), PROXY_PORT (18701).
const http = require("http");
const UP = process.env.UPSTREAM_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const PORT = Number(process.env.PROXY_PORT || 18701);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stats = { ok: 0, retried: 0, failed: 0 }; const methods = {};
async function forwardOne(body) {
  try { const j = JSON.parse(body); for (const m of (Array.isArray(j) ? j : [j])) methods[m.method] = (methods[m.method] || 0) + 1; } catch (e) { /* ignore */ }
  for (let i = 0; i < 6; i++) {
    try {
      // timeout: one upstream call that never answers used to hold the single concurrency slot forever and freeze the indexer, keeper and bot
      const r = await fetch(UP, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 12000)) });
      if (r.status === 429 || r.status >= 500) { stats.retried++; await sleep(400 * 2 ** i); continue; }
      stats.ok++; return { status: r.status, text: await r.text() };
    } catch (e) { stats.retried++; await sleep(400 * 2 ** i); }
  }
  stats.failed++; return { status: 502, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream unavailable after retries" } }) };
}
// The public endpoint answers 429 for batches above ~40 and for bursts: split big batches into chunks of CHUNK (default 20), send chunks one at a time
// with MIN_GAP_MS (default 400) between upstream call starts (global, across clients); PROXY_CONCURRENCY (default 1) calls in flight, then stitch the answers back in order.
const CHUNK = Number(process.env.PROXY_CHUNK || 20), GAP = Number(process.env.PROXY_MIN_GAP_MS || 400);
const CONC = Number(process.env.PROXY_CONCURRENCY || 1); let active = 0, last = 0; const waiters = [];
const acquire = () => new Promise((res) => { const go = () => { active++; res(); }; if (active < CONC) go(); else waiters.push(go); });
const release = () => { active--; const n = waiters.shift(); if (n) n(); };
const slot = async (fn) => { await acquire(); try { const w = last + GAP - Date.now(); last = Math.max(last, Date.now()) + (w > 0 ? 0 : 0); if (w > 0) await sleep(w); return await fn(); } finally { release(); } };

// Short-TTL cache of identical read requests (the UI asks the same eth_call from many components). Never caches eth_sendRawTransaction or anything not listed.
const CACHEABLE = new Set(["eth_call", "eth_blockNumber", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getLogs", "eth_gasPrice", "eth_getCode", "eth_getTransactionReceipt", "eth_getTransactionCount"]);
const TTL = Number(process.env.PROXY_CACHE_MS || 1500); const cache = new Map();
const keyOf = (m) => JSON.stringify([m.method, m.params]);
async function forwardItems(items) { // items: JSON-RPC request objects -> responses in order (ids preserved)
  const out = new Array(items.length), need = [];
  items.forEach((m, i) => {
    const hit = CACHEABLE.has(m.method) ? cache.get(keyOf(m)) : null;
    if (hit && Date.now() - hit.t < TTL) out[i] = { ...hit.r, id: m.id }; else need.push(i);
  });
  for (let c = 0; c < need.length; c += CHUNK) {
    const idx = need.slice(c, c + CHUNK);
    const o = await slot(() => forwardOne(JSON.stringify(idx.length === 1 && !items.isBatch ? items[idx[0]] : idx.map((i) => items[i]))));
    if (o.status !== 200) throw Object.assign(new Error("upstream " + o.status), { out: o });
    const j = JSON.parse(o.text); const arr = Array.isArray(j) ? j : [j];
    idx.forEach((i, k) => { const r = Array.isArray(j) ? arr.find((x) => x.id === items[i].id) || arr[k] : arr[0]; out[i] = r; if (CACHEABLE.has(items[i].method) && r && !r.error) cache.set(keyOf(items[i]), { t: Date.now(), r }); });
  }
  return out;
}
async function forward(body) {
  let j; try { j = JSON.parse(body); } catch (e) { return slot(() => forwardOne(body)); }
  try {
    if (Array.isArray(j)) { const it = j; it.isBatch = true; return { status: 200, text: JSON.stringify(await forwardItems(it)) }; }
    return { status: 200, text: JSON.stringify((await forwardItems([j]))[0]) };
  } catch (e) { return e.out || { status: 502, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: String(e.message) } }) }; }
}
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET, OPTIONS" };
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === "GET") { res.writeHead(200, { ...CORS, "content-type": "application/json" }); res.end(JSON.stringify({ upstreamHost: new URL(UP).host, ...stats, methods })); return; }
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", async () => { const out = await forward(Buffer.concat(chunks).toString()); res.writeHead(out.status, { ...CORS, "content-type": "application/json" }); res.end(out.text); });
}).listen(PORT, "127.0.0.1", () => console.log(`rpc-proxy 127.0.0.1:${PORT} -> ${new URL(UP).host}`));
