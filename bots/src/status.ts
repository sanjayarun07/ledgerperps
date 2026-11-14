/** Prints oracle/mark/book/positions for each bot account and market (on-chain reads). */
import { fromPrice, fromSize, fromUsdc } from "@perps/sdk";
import { ASK_SUB, BID_SUB, MM_INDEXES, TAKER_INDEX, clientFor, getDeployment } from "./config.js";

const d = await getDeployment();
const c = clientFor(TAKER_INDEX, d);
for (const [name, m] of Object.entries(d.marketIds)) {
  const o = await c.oracleStatus(m).catch(() => undefined);
  const mark = await c.markPrice(m).catch(() => undefined);
  const b = await c.bookSnapshot(m, 5);
  const cfg = await c.marketConfig(m, true);
  console.log(`\n${name} state=${cfg.state} oracle=${o ? fromPrice(o.price) + ` (age ${o.ageSec}s fresh=${o.fresh})` : "n/a"} mark=${mark ? fromPrice(mark) : "n/a"}`);
  console.log("  asks:", b.asks.map((l) => `${fromPrice(l.price)}x${fromSize(l.size)}`).reverse().join("  ") || "-");
  console.log("  bids:", b.bids.map((l) => `${fromPrice(l.price)}x${fromSize(l.size)}`).join("  ") || "-");
}
console.log("\nPositions / equity:");
for (const [i, idx] of [...MM_INDEXES.entries()]) {
  const mc = clientFor(idx, d);
  for (const sub of [BID_SUB, ASK_SUB]) {
    const st = await mc.accountState(sub);
    const ps = await mc.positions(sub);
    const oo = await mc.openOrders(sub);
    console.log(`  mm${i + 1} sub${sub}: equity ${fromUsdc(st.equity)} resv ${fromUsdc(st.reservedOrderMargin)} open=${oo.length} pos=${ps.map((p) => `m${p.market}:${fromSize(p.size)}`).join(",") || "flat"}`);
  }
}
const tp = await c.positions();
console.log(`  taker: equity ${fromUsdc((await c.accountState()).equity)} pos=${tp.map((p) => `m${p.market}:${fromSize(p.size)}`).join(",") || "flat"}`);
