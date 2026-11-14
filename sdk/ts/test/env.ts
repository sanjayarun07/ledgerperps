// Test harness: deploys a FRESH exchange (router + 5 modules) + MockUSDC + ManualOracle to the local hardhat node
// using the compiled artifacts in contracts/artifacts, so tests are hermetic and independent of bots/seed state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, toFunctionSelector, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { localChain, PerpClient, type Deployment } from "../src/index.js";

// NEVER default to :8545 - on the dev machine that is the Nitro testnode's L1 geth, and these tests deploy contracts. Start a private node
// (e.g. `cd contracts && npx hardhat node --port 18660`) or set PERP_RPC_URL explicitly. :8545 is refused outright.
export const RPC = process.env.PERP_RPC_URL ?? "http://127.0.0.1:18660";
if (/:8545(\/|$)/.test(RPC)) throw new Error("refusing to run SDK integration tests against :8545 (Nitro testnode L1); use a private hardhat node and PERP_RPC_URL");
const ART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/artifacts/src");
const art = (rel: string) => JSON.parse(fs.readFileSync(path.join(ART, rel), "utf8")) as { abi: any[]; bytecode: Hex };
const MNEMONIC = "test test test test test test test test test test test junk";
export const hhAccount = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

export const FEED = keccak256(toBytes("BTC-USD"));

export interface Env {
  deployment: Deployment;
  chain: ReturnType<typeof localChain>;
  pub: PublicClient;
  admin: ReturnType<typeof hhAccount>;
  wallet: (acct: ReturnType<typeof hhAccount>) => WalletClient;
  client: (acct: ReturnType<typeof hhAccount>, o?: { owner?: Address; sub?: number }) => PerpClient;
  setOracle: (price: bigint) => Promise<void>;
  setOracleAt: (price: bigint, t: bigint) => Promise<void>;
  oracleAbi: any[];
}

export async function chainIsUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function deployFresh(): Promise<Env> {
  const chainId = Number(BigInt((await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json()).result));
  const chain = localChain(chainId, RPC);
  const pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  const admin = hhAccount(0);
  const wallet = (a: ReturnType<typeof hhAccount>) => createWalletClient({ chain, transport: http(RPC), account: a });
  const w = wallet(admin);
  const deploy = async (rel: string, args: any[] = []): Promise<Address> => {
    const a = art(rel);
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: admin, chain });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const usdc = await deploy("MockUSDC.sol/MockUSDC.json");
  const oracle = await deploy("oracles/ManualOracle.sol/ManualOracle.json");
  const exchange = await deploy("PerpExchange.sol/PerpExchange.json", [usdc, oracle, admin.address]);
  const sel = (abi: any[]) => abi.filter((f) => f.type === "function").map((f) => toFunctionSelector(f) as Hex);
  const have = new Set(sel(art("PerpExchange.sol/PerpExchange.json").abi));
  for (const n of ["PerpTrading", "PerpExtras", "PerpLiquidation", "PerpTwap", "PerpAdl"]) {
    const a = art(`${n}.sol/${n}.json`);
    const mod = await deploy(`${n}.sol/${n}.json`);
    const sels = sel(a.abi).filter((s) => !have.has(s));
    sels.forEach((s) => have.add(s));
    const hash = await w.writeContract({ address: exchange, abi: art("PerpExchange.sol/PerpExchange.json").abi, functionName: "registerModule", args: [mod, sels], account: admin, chain });
    await pub.waitForTransactionReceipt({ hash });
  }
  const exAbi = art("PerpExchange.sol/PerpExchange.json").abi;
  const tx = async (fn: string, args: any[], address = exchange, abi: any[] = exAbi) => pub.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName: fn, args, account: admin, chain }) });
  await tx("lockModules", []);
  const oracleAbi = art("oracles/ManualOracle.sol/ManualOracle.json").abi;
  await tx("set", [FEED, 50_000_000_000n], oracle, oracleAbi);
  const MAX = (1n << 128n) - 1n;
  await tx("createMarket", [
    { feed: FEED, tick: 100_000n, lot: 10_000n, minNotional: 10_000_000n, maxOrderSize: 10n ** 12n, maxOI: 10n ** 13n, maxAge: 3600, bandBps: 500, maxSpreadBps: 100, fundingInterval: 3600, premiumDivisor: 8, fundingCap: 400_000_000n },
    [
      { upToNotional: 100_000_000_000n, imrBps: 1000, mmrBps: 500 },
      { upToNotional: 1_000_000_000_000n, imrBps: 2000, mmrBps: 1000 },
      { upToNotional: MAX, imrBps: 5000, mmrBps: 2500 },
    ],
  ]);
  const deployment: Deployment = { chainId, usdc, oracle, exchange, feeds: { "BTC-USD": FEED }, marketIds: { "BTC-USD": 0 } };
  const setOracle = async (price: bigint) => void (await tx("set", [FEED, price], oracle, oracleAbi));
  const setOracleAt = async (price: bigint, t: bigint) => void (await tx("setAt", [FEED, price, t], oracle, oracleAbi));
  const client = (acct: ReturnType<typeof hhAccount>, o: { owner?: Address; sub?: number } = {}) =>
    new PerpClient({ publicClient: pub, walletClient: wallet(acct), exchange, usdc, oracle, owner: o.owner, sub: o.sub });
  return { deployment, chain, pub, admin, wallet, client, setOracle, setOracleAt, oracleAbi };
}

/** mint + approve + deposit for a hardhat account */
export async function fund(env: Env, i: number, usd: bigint): Promise<PerpClient> {
  const c = env.client(hhAccount(i));
  await c.mintMockUsdc(c.owner, usd);
  await c.approveUsdc();
  await c.deposit(usd);
  return c;
}
