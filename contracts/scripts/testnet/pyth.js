// Manual Pyth price push helper (stop-gap until the keeper has a pyth pusher; see docs/TESTNET_RUNBOOK.md TODO).
const { ethers } = require("hardhat");
const PYTH_ABI = ["function getUpdateFee(bytes[] calldata) view returns (uint256)", "function updatePriceFeeds(bytes[] calldata) payable"];

async function fetchUpdates(cfg, hermes = process.env.HERMES_URL || cfg.pyth.hermes) {
  const ids = cfg.markets.filter((m) => m.pyth).map((m) => "ids[]=" + m.pyth.feedId.replace(/^0x/, ""));
  const url = `${hermes}/v2/updates/price/latest?${ids.join("&")}&encoding=hex`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes ${res.status} at ${hermes.split("?")[0]}. The public Hermes endpoints returned 401 unauthorized when this was written (2026-11-14); set HERMES_URL to an endpoint you have access to (a provider URL may embed its own key - do not paste it in chat).`);
  const j = await res.json();
  return { url: url.split("?")[0], updates: j.binary.data.map((h) => "0x" + h), parsed: (j.parsed || []).length };
}

/** Read-only: returns the fee. Throws (revert) if this Pyth contract would reject the update (e.g. wrong Hermes channel). */
async function quoteFee(cfg, updates) {
  const p = new ethers.Contract(cfg.pyth.address, PYTH_ABI, ethers.provider);
  return p.getUpdateFee(updates);
}

async function push(cfg, signer, updates) {
  const p = new ethers.Contract(cfg.pyth.address, PYTH_ABI, signer);
  const fee = await p.getUpdateFee(updates);
  await p.updatePriceFeeds.staticCall(updates, { value: fee }); // simulate first
  const tx = await p.updatePriceFeeds(updates, { value: fee });
  const rc = await tx.wait();
  return { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), fee: fee.toString() };
}
module.exports = { fetchUpdates, quoteFee, push };
