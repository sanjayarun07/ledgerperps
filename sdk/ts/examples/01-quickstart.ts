// Run: pnpm tsx examples/01-quickstart.ts   (needs `npx hardhat node` + deploy.js --network localhost)
import { clientFor, fundIfNeeded } from "./_common.js";
import { fromPrice, fromSize, fromUsdc, Tif, toPrice, toSize } from "../src/index.js";

const maker = clientFor(10);
const taker = clientFor(11);
await fundIfNeeded(maker, 50_000);
await fundIfNeeded(taker, 10_000);

const mark = await maker.markPrice(0);
console.log("BTC-USD mark", fromPrice(mark));

// resting limit ask 0.5% above mark, rounded to tick
const cfg = await maker.marketConfig(0);
const askPx = ((mark * 10050n) / 10000n / cfg.tick) * cfg.tick;
const ask = await maker.placeOrder({ market: 0, isBuy: false, price: askPx, size: toSize("0.1"), tif: Tif.GTC });
console.log("resting ask id", ask.orderId, "at", fromPrice(askPx));
console.log("book", await maker.bookSnapshot(0, 3));

// market-as-IOC buy with 1% slippage
const fill = await taker.marketOrder({ market: 0, isBuy: true, size: toSize("0.05"), slippageBps: 100 });
console.log("taker filled", fromSize(fill.filled), "fills", fill.fills.map((f) => fromPrice(f.price)));
console.log("taker positions", await taker.positions());
const st = await taker.accountState();
console.log("taker equity", fromUsdc(st.equity), "IM", fromUsdc(st.initialMargin), "available", fromUsdc(st.available));

await maker.cancelAll();
