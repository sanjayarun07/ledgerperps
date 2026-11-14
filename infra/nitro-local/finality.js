// Finality stages for one L2 tx: submit -> sequencer receipt -> batch posted to L1 (from sequencer docker logs, READ ONLY) -> L2 'safe' -> 'finalized'.
// Run: cd contracts && npx hardhat --config hardhat.nitro.config.js run ../infra/nitro-local/finality.js --network nitroLocal
const { ethers } = require("hardhat");
const { execSync } = require("child_process");
const p = ethers.provider;
const l1 = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = async (t) => { try { const b = await p.send("eth_getBlockByNumber", [t, false]); return b ? parseInt(b.number, 16) : null; } catch (e) { return "ERR:" + e.message.slice(0, 60); } };
const l1tag = async (t) => { try { const b = await l1.send("eth_getBlockByNumber", [t, false]); return b ? parseInt(b.number, 16) : null; } catch (e) { return "ERR:" + e.message.slice(0, 60); } };
async function main() {
  const [s] = await ethers.getSigners();
  console.log("L2 at start  latest/safe/finalized:", await tag("latest"), await tag("safe"), await tag("finalized"));
  console.log("L1 at start  latest/safe/finalized:", await l1tag("latest"), await l1tag("safe"), await l1tag("finalized"));
  const t0 = Date.now(); const tx = await s.sendTransaction({ to: s.address, value: 1 }); const tSub = Date.now();
  const r = await tx.wait(); const tRec = Date.now(); const X = r.blockNumber;
  console.log(`tx ${tx.hash} L2 block ${X}; submit ack ${tSub - t0} ms, receipt ${tRec - t0} ms after send`);
  let tSafe = null, tFin = null, tBatch = null, batchLine = null;
  const sinceIso = new Date(t0 - 2000).toISOString();
  while (Date.now() - t0 < 600_000 && !(tSafe && tFin && tBatch)) {
    if (!tBatch) {
      const log = execSync(`docker logs --timestamps --since ${sinceIso} nitro-testnode-sequencer-1 2>&1 | grep 'BatchPoster: batch sent' || true`, { encoding: "utf8", maxBuffer: 1 << 26 });
      for (const line of log.split("\n")) {
        const m = line.match(/^(\S+) .*sequenceNumber=(\d+) from=(\d+) to=(\d+)/);
        if (m && +m[3] <= X && X < +m[4]) { tBatch = new Date(m[1]).getTime(); batchLine = line.slice(0, 220); }
      }
    }
    const sf = await tag("safe"), fz = await tag("finalized");
    if (!tSafe && typeof sf === "number" && sf >= X) tSafe = Date.now();
    if (!tFin && typeof fz === "number" && fz >= X) tFin = Date.now();
    await sleep(500);
  }
  const d = (t) => (t ? ((t - t0) / 1000).toFixed(1) + " s" : "NOT REACHED within 600 s");
  console.log("t+ receipt (sequencer-accepted):", d(tRec));
  console.log("t+ batch sent to L1 (docker log timestamp, clock of container=host):", d(tBatch), batchLine || "");
  console.log("t+ L2 safe >= block:", d(tSafe));
  console.log("t+ L2 finalized >= block:", d(tFin));
  console.log("L2 at end    latest/safe/finalized:", await tag("latest"), await tag("safe"), await tag("finalized"));
  console.log("L1 at end    latest/safe/finalized:", await l1tag("latest"), await l1tag("safe"), await l1tag("finalized"));
}
main().catch((e) => { console.error(e); process.exit(1); });
