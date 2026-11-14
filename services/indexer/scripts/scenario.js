// E2E trading scenario. Run with:  hardhat --config scripts/hardhat.e2e.config.js run scripts/scenario.js --network localhost
// Reads the deployment written by contracts/scripts/deploy.js (DEPLOYMENT env), trades, and writes EXPECTED (env) =
// ground truth read straight from the contracts (views + ethers-decoded events), independent of the Rust indexer.
const path = require("path");
const fs = require("fs");
const CONTRACTS = process.env.CONTRACTS_DIR || path.resolve(__dirname, "../../../contracts");
const hre = require(path.join(CONTRACTS, "node_modules/hardhat"));
const { ethers } = hre;

const usd = (n) => BigInt(Math.round(n * 1e6));
const btc = (x) => BigInt(Math.round(x * 1e8));
const GTC = 0, IOC = 1;
const ord = (o) => ({ market: o.market ?? 0, isBuy: o.isBuy, price: o.price, size: o.size, tif: o.tif ?? GTC, reduceOnly: o.reduceOnly ?? false, cloid: o.cloid ?? 0n, expiry: o.expiry ?? 0n });
const bump = async (secs) => { await ethers.provider.send("evm_increaseTime", [secs]); await ethers.provider.send("evm_mine", []); };

async function main() {
  const dep = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/PerpExchange.merged.json"), "utf8"));
  const usdcAbi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/MockUSDC.json"), "utf8"));
  const oracleAbi = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/ManualOracle.json"), "utf8"));
  const [admin, alice, bob, carol, dave, keeper, erin, frank, grace] = await ethers.getSigners();
  const ex = new ethers.Contract(dep.exchange, abi, admin);
  const usdc = new ethers.Contract(dep.usdc, usdcAbi, admin);
  const oracle = new ethers.Contract(dep.oracle, oracleAbi, admin);
  const FEED = dep.feeds["BTC-USD"];
  const setBtc = (p) => oracle.set(FEED, usd(p));
  const refresh = async () => { for (const [n, p] of [["BTC-USD", null], ["ETH-USD", 3000], ["SOL-USD", 150]]) if (p) await oracle.set(dep.feeds[n], usd(p)); };
  const key = (s, sub = 0) => ex.acctKey(s.address, sub);
  const place = (s, o) => ex.connect(s).placeOrder(s.address, 0, ord(o));
  const px = usd;

  // ---- funding the accounts
  for (const [s, amt] of [[alice, 200_000], [bob, 200_000], [carol, 6_000], [dave, 300_000]]) {
    await usdc.mint(s.address, usd(amt));
    await usdc.connect(s).approve(dep.exchange, ethers.MaxUint256);
    await ex.connect(s).deposit(s.address, 0, usd(amt));
  }
  await ex.connect(alice).approveAgent(0, keeper.address, 4102444800n);

  // ---- BTC book + trades (partial fills, multi-level sweep, cancel)
  await place(bob, { isBuy: false, price: px(50000), size: btc(1) });            // order 1
  await place(bob, { isBuy: false, price: px(50100), size: btc(0.5) });          // order 2
  await place(bob, { isBuy: true, price: px(49000), size: btc(1) });             // order 3
  await place(alice, { isBuy: true, price: px(50000), size: btc(0.4), tif: IOC });   // fill 0.4 of #1
  await place(alice, { isBuy: true, price: px(50100), size: btc(0.8), tif: IOC });   // 0.6 of #1 (filled), 0.2 of #2
  await ex.connect(bob).cancelOrder(3);                                           // user cancel
  await place(bob, { isBuy: false, price: px(50000), size: btc(2) });            // order 6 (resting ask for carol/twap)
  await place(carol, { isBuy: true, price: px(50000), size: btc(1), tif: IOC }); // levered long, carol (6k collateral)
  // dave: rest + cancelAll, and an ask with a short expiry that will expire
  await place(dave, { isBuy: true, price: px(49500), size: btc(0.3) });
  await ex.connect(dave).cancelAll(dave.address, 0);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await place(dave, { isBuy: false, price: px(51000), size: btc(0.1), expiry: BigInt(now + 30) });
  await bump(100); await refresh(); await setBtc(50000);
  // walks #6 (1 BTC left), #2 (0.3 left), then touches dave's expired ask (OrderCanceled Expired); IOC remainder cancels
  await place(alice, { isBuy: true, price: px(51000), size: btc(1.5), tif: IOC });

  // ---- second market (ETH)
  await ex.connect(bob).placeOrder(bob.address, 0, ord({ market: 1, isBuy: false, price: px(3000), size: btc(2) * 100n / 100n }));
  await ex.connect(alice).placeOrder(alice.address, 0, ord({ market: 1, isBuy: true, price: px(3000), size: btc(1), tif: IOC }));

  // ---- conditional + bracket + TWAP
  await place(bob, { isBuy: false, price: px(50000), size: btc(1) });               // liquidity for the TWAP slices
  await ex.connect(alice).placeConditional(alice.address, 0, 0, false, true, px(60000), px(59900), btc(0.1), true); // cond 1
  await ex.connect(alice).cancelConditional(1);
  await ex.connect(alice).placeBracket(alice.address, 0, 0, px(55000), px(54900), px(45000), px(44900), btc(0.2)); // conds 2,3
  await ex.connect(alice).placeTwap(alice.address, 0, 0, true, btc(0.4), 2, 60, 100, false);                       // twap 1
  await ex.connect(keeper).executeTwapSlice(1);
  await bump(61); await refresh(); await setBtc(50000);
  await ex.connect(keeper).executeTwapSlice(1);                                                                   // TwapDone

  // ---- funding: make mark != index (book mid vs oracle) so a non-zero rate is applied, then settle on next action
  await place(bob, { isBuy: false, price: px(50000), size: btc(0.5) });
  await place(dave, { isBuy: true, price: px(49900), size: btc(0.2) });
  await setBtc(49800);
  await ex.connect(keeper).pokeFunding(0);
  for (let i = 0; i < 6; i++) { await bump(700); await refresh(); await setBtc(49800); await ex.connect(keeper).pokeFunding(0); }
  await place(alice, { isBuy: true, price: px(49000), size: btc(0.1) }); // settles alice's funding (emits FundingSettled)
  await ex.connect(alice).cancelAll(alice.address, 0);

  // ---- trigger the take-profit leg of the bracket (OCO), no liquidity => IOC child cancels
  await ex.connect(dave).cancelAll(dave.address, 0);
  await ex.connect(bob).cancelAll(bob.address, 0);
  await setBtc(55100);
  await ex.connect(keeper).executeConditional(2);

  // ---- liquidation of carol (one-sided/empty book => mark == index)
  await setBtc(45500);
  const ck = await key(carol);
  await ex.connect(keeper).liquidate(ck, 0);

  // ---- collateral movements, isolated margin, market state
  await setBtc(50000);
  await ex.connect(dave).withdraw(0, usd(100));
  await ex.connect(alice).transferInternal(0, 1, usd(5000));
  await ex.connect(dave).setIsolated(0, 1, true);
  await ex.connect(dave).addIsoMargin(0, 1, usd(1000));
  await ex.connect(dave).removeIsoMargin(0, 1, usd(400));
  await ex.setMarketState(1, 1);
  await ex.setMarketState(1, 0);

  // ---- gap-move bad debt -> ADL -> recapitalisation on SOL (market 2). Isolated accounts, so nothing above changes.
  //   erin (200 USDC) goes long 10 SOL @150 against frank (short 6) and grace (short 4); SOL gaps 150 -> 80 in one oracle
  //   update. Liquidation leaves a deficit beyond the insurance fund (BadDebtUnresolved), the backstop holds +10 SOL,
  //   ADL force-closes frank (the ranked profitable short) against the backstop at mark +/- concession, and a third party
  //   recapitalises whatever debt the 25% concession cap could not clear.
  const SOLFEED = dep.feeds["SOL-USD"];
  for (const [sg, amt] of [[erin, 200], [frank, 50_000], [grace, 50_000]]) {
    await usdc.mint(sg.address, usd(amt));
    await usdc.connect(sg).approve(dep.exchange, ethers.MaxUint256);
    await ex.connect(sg).deposit(sg.address, 0, usd(amt));
  }
  await oracle.set(SOLFEED, usd(150));
  await place(frank, { market: 2, isBuy: false, price: px(150), size: btc(6) });
  await place(grace, { market: 2, isBuy: false, price: px(150), size: btc(4) });
  await place(erin, { market: 2, isBuy: true, price: px(150), size: btc(10), tif: IOC });
  const erinKey = await key(erin), frankKey = await key(frank), BACK = await ex.BACKSTOP();
  const debtBefore = await ex.adlDebt(2);
  await oracle.set(SOLFEED, usd(80));                       // -47% gap
  await ex.connect(keeper).liquidate(erinKey, 2);
  const debtAfterLiq = await ex.adlDebt(2);
  if (debtAfterLiq <= debtBefore) throw new Error("scenario bug: liquidation left no bad debt");
  const backBeforeAdl = await ex.positions(BACK, 2);
  await ex.connect(keeper).adl([frankKey], 2);
  const debtAfterAdl = await ex.adlDebt(2);
  if (!(debtAfterAdl > 0n && debtAfterAdl < debtAfterLiq)) throw new Error(`scenario bug: ADL should clear part of the debt (${debtAfterLiq} -> ${debtAfterAdl})`);
  await usdc.mint(carol.address, debtAfterAdl);
  await ex.connect(carol).recapitalize(2, debtAfterAdl);
  if ((await ex.adlDebt(2)) !== 0n) throw new Error("scenario bug: recapitalize should clear the debt");
  await oracle.set(SOLFEED, usd(150));
  const adlCtx = { debtAfterLiq: debtAfterLiq.toString(), debtAfterAdl: debtAfterAdl.toString(), unresolvedAfter: (await ex.unresolvedBadDebt()).toString(),
    backstopBeforeAdl: { size: backBeforeAdl.size.toString(), basis: backBeforeAdl.basis.toString() } };

  // ---- leave live orders behind: one fully resting ask, and a bid that gets partially filled
  await place(bob, { isBuy: false, price: px(52000), size: btc(1) });                 // open
  await place(alice, { isBuy: true, price: px(48000), size: btc(1) });                // partially filled below
  await place(dave, { isBuy: false, price: px(48000), size: btc(0.4), tif: IOC });    // fills 0.4 of alice's bid

  // ---- backstop PHASE 2 (inventory management) on SOL: the backstop is still long after the ADL above. Enable the market, elevate it,
  //   let alice TAKE 1 SOL from the Dutch auction, then (after maxAge) unwind grace (profitable short) against the backstop at mark.
  //   Neither takeBackstop nor unwindBackstop emits a Fill: the indexer must move both legs from BackstopTaken / BackstopUnwound.
  await ex.setBackstopCfg(2, 1_000_000, 300, 0, 60, 60);
  await ex.setBackstopTakeFee(5);
  await ex.setBackstopPlaceOpen(false);
  await ex.setBackstopPlaceOpen(true);
  await oracle.set(SOLFEED, usd(80));
  await ex.pokeBackstop(2);                                                   // BackstopElevated
  const aliceAddr = alice.address;
  const takeRc = await (await ex.connect(alice).takeBackstop(aliceAddr, 0, 2, btc(1), px(1000))).wait();
  const takeEv = takeRc.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "BackstopTaken");
  if (!takeEv) throw new Error("scenario bug: no BackstopTaken");
  await ethers.provider.send("evm_increaseTime", [61]); await ethers.provider.send("evm_mine", []);
  await oracle.set(SOLFEED, usd(80));                                         // refresh the feed after the time jump
  const graceKey = await key(grace);
  const unwRc = await (await ex.connect(keeper).unwindBackstop([graceKey], 2)).wait();
  const unwEv = unwRc.logs.map((l) => { try { return ex.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "BackstopUnwound");
  if (!unwEv) throw new Error("scenario bug: no BackstopUnwound");
  await oracle.set(SOLFEED, usd(150));
  adlCtx.phase2 = { takePrice: takeEv.args.price.toString(), takeSize: takeEv.args.size.toString(), takeFee: takeEv.args.fee.toString(), takeDisc: takeEv.args.discBps.toString(), takerSold: takeEv.args.takerSold,
    unwSize: unwEv.args.size.toString(), unwPrice: unwEv.args.price.toString(), alice: aliceAddr };

  await dumpExpected(ex, dep, { alice, bob, carol, dave, keeper, erin, frank, grace }, adlCtx);
}

async function dumpExpected(ex, dep, signers, adlCtx) {
  const provider = ethers.provider;
  const head = await provider.getBlockNumber();
  const evs = await ex.queryFilter(ex.filters.Fill(), 0, head); // decoded by ethers, not by the indexer
  const tsOf = {};
  const fills = [];
  for (const e of evs) {
    if (!(e.blockNumber in tsOf)) tsOf[e.blockNumber] = (await provider.getBlock(e.blockNumber)).timestamp;
    fills.push({ tradeId: e.args.tradeId.toString(), market: Number(e.args.market), price: e.args.price.toString(), size: e.args.size.toString(), maker: e.args.maker, taker: e.args.taker, ts: tsOf[e.blockNumber] });
  }
  // independent 1m candle computation (open/close = first/last fill by log order)
  const candles = {};
  for (const f of fills) {
    const t = f.ts - (f.ts % 60), k = `${f.market}:${t}`;
    const px = BigInt(f.price), sz = BigInt(f.size), q = (sz * px) / 100000000n;
    if (!candles[k]) candles[k] = { market: f.market, t, o: px, h: px, l: px, c: px, v: 0n, qv: 0n, n: 0 };
    const c = candles[k];
    if (px > c.h) c.h = px; if (px < c.l) c.l = px; c.c = px; c.v += sz; c.qv += q; c.n++;
  }
  const accts = {};
  for (const [name, s] of Object.entries(signers)) accts[name] = await ex.acctKey(s.address, 0);
  accts.alice_sub1 = await ex.acctKey(signers.alice.address, 1);
  accts.backstop = await ex.BACKSTOP();
  const positions = {};
  const markets = {};
  for (let m = 0; m < 3; m++) {
    const mk = await ex.getMarket(m);
    const [bp, bs] = await ex.bookSnapshot(m, true, 20);
    const [ap, as] = await ex.bookSnapshot(m, false, 20);
    const lv = (p, s) => p.map((x, i) => [x.toString(), s[i].toString()]).filter((x) => x[1] !== "0" && x[0] !== "0");
    markets[m] = { bids: lv(bp, bs), asks: lv(ap, as), fundingIndex: mk.fundingIndex.toString(), oi: mk.oi.toString(), lastTradePrice: mk.lastTradePrice.toString(), state: Number(mk.state) };
    for (const [name, a] of Object.entries(accts)) {
      const p = await ex.positions(a, m);
      if (p.size !== 0n) positions[`${name}:${m}`] = { size: p.size.toString(), basis: p.basis.toString() };
    }
  }
  const openOrders = {};
  for (const [name, a] of Object.entries(accts)) { const ids = await ex.openOrderIds(a); if (ids.length) openOrders[name] = ids.map(String); }
  const count = async (f) => (await ex.queryFilter(f, 0, head)).length;
  const counts = {
    Deposit: await count(ex.filters.Deposit()), Withdraw: await count(ex.filters.Withdraw()), Liquidated: await count(ex.filters.Liquidated()),
    FundingUpdated: await count(ex.filters.FundingUpdated()), FundingSettled: await count(ex.filters.FundingSettled()),
    OrderAccepted: await count(ex.filters.OrderAccepted()), TwapSlice: await count(ex.filters.TwapSlice()), CondTriggered: await count(ex.filters.CondTriggered()),
    Fill: fills.length,
    BackstopCfgSet: await count(ex.filters.BackstopCfgSet()), BackstopElevated: await count(ex.filters.BackstopElevated()), BackstopTaken: await count(ex.filters.BackstopTaken()),
    BackstopUnwound: await count(ex.filters.BackstopUnwound()), BackstopRelaxed: await count(ex.filters.BackstopRelaxed()),
    BackstopPlaceOpenSet: await count(ex.filters.BackstopPlaceOpenSet()), BackstopTakeFeeSet: await count(ex.filters.BackstopTakeFeeSet()),
    BadDebtUnresolved: await count(ex.filters.BadDebtUnresolved()), AdlExecuted: await count(ex.filters.AdlExecuted()), Recapitalized: await count(ex.filters.Recapitalized()),
  };
  // ---- bad debt / ADL / recapitalisation ground truth: ethers-decoded events + contract views
  const lg = async (f) => (await ex.queryFilter(f, 0, head)).sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const badDebt = [];
  for (const e of await lg(ex.filters.BadDebtUnresolved())) badDebt.push({ kind: "bad_debt_unresolved", block: e.blockNumber, idx: e.index, acct: e.args.acct, amount: e.args.amount.toString() });
  for (const e of await lg(ex.filters.AdlExecuted())) badDebt.push({ kind: "adl", block: e.blockNumber, idx: e.index, acct: e.args.target, market: Number(e.args.market), size: e.args.size.toString(), price: e.args.price.toString(), amount: e.args.debtCleared.toString() });
  for (const e of await lg(ex.filters.Recapitalized())) badDebt.push({ kind: "recapitalized", block: e.blockNumber, idx: e.index, market: Number(e.args.market), amount: e.args.amount.toString() });
  badDebt.sort((a, b) => a.block - b.block || a.idx - b.idx);
  const liqs = (await lg(ex.filters.Liquidated())).map((e) => ({ acct: e.args.acct, market: Number(e.args.market), size: e.args.size.toString(), price: e.args.price.toString(), badDebt: e.args.badDebt.toString() }));
  const bs = await ex.positions(accts.backstop, 2);
  const adl = { ...adlCtx, badDebt, liquidations: liqs, adlDebtNow: (await ex.adlDebt(2)).toString(), unresolvedNow: (await ex.unresolvedBadDebt()).toString(),
    backstopNow: { size: bs.size.toString(), basis: bs.basis.toString() } };
  const out = { head, accts, fills, candles: Object.values(candles).map((c) => ({ ...c, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString(), v: c.v.toString(), qv: c.qv.toString() })), markets, positions, openOrders, counts, adl };
  fs.writeFileSync(process.env.EXPECTED, JSON.stringify(out, null, 2));
  console.log(`scenario done: head=${head} fills=${fills.length} counts=${JSON.stringify(counts)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
