import { describe, expect, it } from "vitest";
import { ERC20_ABI, NETWORKS, addChainParams, bannerText, chainStatus, confirmationsText, DEPOSIT_TEXT, depositStep, explorerAddress, explorerTx, footerNetworkLabel, isRateLimit, mainnetGuard, networkInfo, networkKind, nextPollDelay, oracleDegradedText, switchLabel } from "./network";
import { BASE_BANNER, parseBrand, disclaimerText } from "@/brand/schema";
import base from "../../brand.config.json";

const H = "0x" + "ab".repeat(32), A = "0x" + "cd".repeat(20);

describe("network kind", () => {
  it("infers from the chain id", () => {
    expect(networkKind(31337)).toBe("local"); expect(networkKind(1337)).toBe("local");
    expect(networkKind(421614)).toBe("testnet"); expect(networkKind(42161)).toBe("mainnet"); expect(networkKind(1)).toBe("mainnet");
  });
  it("an unknown chain is treated as mainnet (strict side)", () => expect(networkKind(999999)).toBe("mainnet"));
  it("an explicit kind wins, junk is ignored", () => { expect(networkKind(31337, "testnet")).toBe("testnet"); expect(networkKind(421614, "bogus")).toBe("testnet"); });
  it("Arbitrum Sepolia has the documented defaults", () => {
    const n = networkInfo(421614);
    expect(n).toMatchObject({ name: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io", defaultRpc: "https://sepolia-rollup.arbitrum.io/rpc" });
    expect(n.faucets?.usdc).toBe("https://faucet.circle.com");
  });
  it("the explorer is configurable", () => expect(networkInfo(421614, "testnet", "https://scan.example").explorer).toBe("https://scan.example"));
});

describe("explorer links", () => {
  const t = networkInfo(421614);
  it("builds tx and address URLs", () => { expect(explorerTx(t, H)).toBe(`https://sepolia.arbiscan.io/tx/${H}`); expect(explorerAddress(t, A)).toBe(`https://sepolia.arbiscan.io/address/${A}`); });
  it("trims trailing slashes on configured explorers", () => expect(explorerTx(networkInfo(421614, "testnet", "https://scan.example//"), H)).toBe(`https://scan.example/tx/${H}`));
  it("rejects malformed hashes and addresses", () => { expect(explorerTx(t, "0x12")).toBeUndefined(); expect(explorerAddress(t, "nope")).toBeUndefined(); });
  it("local has no explorer", () => { expect(explorerTx(networkInfo(31337), H)).toBeUndefined(); });
});

describe("banner and footer text per mode", () => {
  it("local keeps the demo banner", () => expect(bannerText(networkInfo(31337))).toBe(BASE_BANNER));
  it("testnet banner is the documented text", () => expect(bannerText(networkInfo(421614))).toBe("TESTNET - Arbitrum Sepolia - test funds only"));
  it("mainnet banner warns about real funds", () => expect(bannerText(networkInfo(42161))).toContain("real funds at risk"));
  it("footer network labels", () => { expect(footerNetworkLabel(networkInfo(31337))).toBe("Local demo chain"); expect(footerNetworkLabel(networkInfo(421614))).toBe("Arbitrum Sepolia (testnet)"); expect(footerNetworkLabel(networkInfo(42161))).toBe("Arbitrum One"); });
  const brand = parseBrand(base);
  it("disclaimerText follows the network and defaults to local", () => {
    expect(disclaimerText(brand, false)).toBe(BASE_BANNER);
    expect(disclaimerText(brand, false, networkInfo(421614))).toBe("TESTNET - Arbitrum Sepolia - test funds only");
  });
  it("a real-deployment override can never hide the testnet banner, but may replace the local or mainnet one", () => {
    const o = parseBrand({ ...base, disclaimer: { extra: "", override: "Custom" } });
    expect(disclaimerText(o, true, networkInfo(421614))).toBe("TESTNET - Arbitrum Sepolia - test funds only");
    expect(disclaimerText(o, true, networkInfo(31337))).toBe("Custom");
    expect(disclaimerText(o, true, networkInfo(42161))).toBe("Custom");
    expect(disclaimerText(o, false, networkInfo(42161))).toContain("MAINNET");
  });
  it("tenant extra text is appended on testnet", () => expect(disclaimerText(parseBrand({ ...base, disclaimer: { extra: "Demo tenant." } }), false, networkInfo(421614))).toBe("TESTNET - Arbitrum Sepolia - test funds only. Demo tenant."));
});

describe("mainnet guard", () => {
  it("refuses mainnet without the real-deployment flag", () => { const g = mainnetGuard("mainnet", false); expect(g.ok).toBe(false); if (!g.ok) expect(g.message).toContain("NEXT_PUBLIC_REAL_DEPLOYMENT=1"); });
  it("allows mainnet with the flag, and local/testnet always", () => { expect(mainnetGuard("mainnet", true).ok).toBe(true); expect(mainnetGuard("testnet", false).ok).toBe(true); expect(mainnetGuard("local", false).ok).toBe(true); });
});

describe("chain switch logic", () => {
  it("add-chain params for Arbitrum Sepolia", () => expect(addChainParams(networkInfo(421614), "https://sepolia-rollup.arbitrum.io/rpc")).toEqual({
    chainId: "0x66eee", chainName: "Arbitrum Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"], blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  }));
  it("local params carry no explorer", () => expect(addChainParams(networkInfo(31337), "http://127.0.0.1:8545")).not.toHaveProperty("blockExplorerUrls"));
  it("chain status gates trading", () => { expect(chainStatus(421614, 421614)).toBe("ok"); expect(chainStatus(1, 421614)).toBe("wrong"); expect(chainStatus(undefined, 421614)).toBe("unknown"); });
  it("switch label names the network on testnet", () => { expect(switchLabel(networkInfo(421614))).toBe("Switch to Arbitrum Sepolia"); expect(switchLabel(networkInfo(31337))).toBe("Switch network"); });
});

describe("approve + deposit state machine (6 decimals)", () => {
  const usdc = (n: number) => BigInt(Math.round(n * 1e6));
  it("walks enter -> insufficient / needs-approve / ready", () => {
    expect(depositStep({ amount: null, bal: usdc(5), allowance: 0n })).toBe("enter-amount");
    expect(depositStep({ amount: 0n, bal: usdc(5), allowance: 0n })).toBe("enter-amount");
    expect(depositStep({ amount: usdc(10), bal: usdc(5), allowance: usdc(100) })).toBe("insufficient-balance");
    expect(depositStep({ amount: usdc(10), bal: usdc(50), allowance: usdc(9.999999) })).toBe("needs-approve");
    expect(depositStep({ amount: usdc(10), bal: usdc(50), allowance: usdc(10) })).toBe("ready");
    expect(depositStep({ amount: usdc(10), bal: usdc(50), allowance: 2n ** 255n })).toBe("ready");
  });
  it("pending steps override the rest and have two-step text", () => {
    expect(depositStep({ amount: usdc(1), bal: 0n, allowance: 0n, pending: "approve" })).toBe("approving");
    expect(depositStep({ amount: usdc(1), bal: 0n, allowance: 0n, pending: "deposit" })).toBe("depositing");
    expect(DEPOSIT_TEXT["needs-approve"]).toMatch(/Step 1 of 2/); expect(DEPOSIT_TEXT.ready).toMatch(/Step 2 of 2/);
  });
  it("the ERC-20 ABI has approve/allowance/balanceOf and no mint", () => {
    const names = ERC20_ABI.map((f) => f.name); expect(names).toEqual(expect.arrayContaining(["approve", "allowance", "balanceOf", "decimals"])); expect(names).not.toContain("mint");
  });
});

describe("receipts, confirmations, rate limits", () => {
  it("backs off and caps", () => { expect([0, 1, 2, 3].map((a) => nextPollDelay(a))).toEqual([1000, 1500, 2250, 3375]); expect(nextPollDelay(20)).toBe(8000); });
  it("a rate limit jumps to the cap", () => expect(nextPollDelay(0, true)).toBe(8000));
  it("detects rate-limit errors", () => { expect(isRateLimit(new Error("HTTP 429 Too Many Requests"))).toBe(true); expect(isRateLimit({ shortMessage: "rate limit exceeded" })).toBe(true); expect(isRateLimit(new Error("execution reverted"))).toBe(false); });
  it("confirmation text", () => { expect(confirmationsText(undefined, 5n)).toBe("Waiting for confirmation"); expect(confirmationsText(10n, 10n)).toBe("1 confirmation"); expect(confirmationsText(10n, 14n)).toBe("5 confirmations"); });
});

describe("oracle degraded text", () => {
  it("names the stale sources and the consequence", () => { const t = oracleDegradedText(); expect(t).toMatch(/Price feed delayed/); expect(t).toMatch(/Pyth or Chainlink/); expect(t).toMatch(/New positions are temporarily unavailable/); });
  it("includes the age when known", () => { expect(oracleDegradedText(45)).toContain("45s ago"); expect(oracleDegradedText(600)).toContain("10 min ago"); });
  it("table sanity", () => expect(NETWORKS[421614].chainId).toBe(421614));
});
