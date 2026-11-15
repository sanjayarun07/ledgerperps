"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWalletClient } from "wagmi";
import { createWalletClient, custom, encodeAbiParameters, http, keccak256, type Address, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chain, CHAIN_ID, IS_LOCAL, RPC_URL } from "./config";
import { usePrivyState } from "./privy";

/** The well-known public Hardhat/Anvil dev mnemonic. DEV ONLY: its keys are public and worth nothing on a real chain. */
const DEV_MNEMONIC = "test test test test test test test test test test test junk";

export type BurnerSpec = { kind: "hardhat"; index: number } | { kind: "random"; pk: Hex };
export type Mode = "none" | "injected" | "burner" | "privy";

export const acctKey = (owner: Address, sub: number): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [owner, sub]));

interface Ctx {
  mode: Mode;
  address?: Address;
  walletClient?: WalletClient;
  /** Session (agent) key: trading-only. Undefined if none generated. */
  agentAccount?: PrivateKeyAccount;
  agentClient?: WalletClient;
  useAgentKey: boolean;
  setUseAgentKey(v: boolean): void;
  generateAgentKey(): void;
  forgetAgentKey(): void;
  /** Dev relayer (LOCAL only): a different Hardhat account that submits `placeSigned` orders the browser signed. */
  relayerAccount?: PrivateKeyAccount;
  relayerClient?: WalletClient;
  useRelayer: boolean;
  setUseRelayer(v: boolean): void;
  sub: number;
  setSub(n: number): void;
  acct?: Hex;
  burnerAllowed: boolean;
  connectInjected(): void;
  /** Email sign-in (embedded wallet). Present only when a Privy app id is configured. */
  connectEmail?(): void;
  email?: string;
  mfaEnrolled?: boolean;
  enrollMfa?(): void;
  connectBurner(spec: BurnerSpec): void;
  disconnect(): void;
  wrongChain: boolean;
  switchChain(): void;
  ready: boolean;
  connectError?: string;
}
const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("WalletProvider missing");
  return c;
};

const LS = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function burnerAccount(s: BurnerSpec): PrivateKeyAccount {
  if (s.kind === "random") return privateKeyToAccount(s.pk);
  const a = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: s.index });
  return privateKeyToAccount(`0x${Buffer.from(a.getHdKey().privateKey!).toString("hex")}`);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [burner, setBurner] = useState<BurnerSpec | null>(null);
  const [wantInjected, setWantInjected] = useState(false);
  const [sub, setSubState] = useState(0);
  const [agentPk, setAgentPk] = useState<Hex | null>(null);
  const [useAgentKey, setUseAgentKeyState] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  const [useRelayer, setUseRelayerState] = useState(false);

  const { address: wagmiAddr, chainId: wagmiChain, isConnected } = useAccount();
  const { data: wagmiWallet } = useWalletClient();
  const { connect, connectors } = useConnect({ mutation: { onError: (e) => setConnectError(e.message) } });
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { switchChain: wagmiSwitch } = useSwitchChain();

  const privy = usePrivyState();
  const [wantPrivy, setWantPrivy] = useState(false);
  const burnerAllowed = IS_LOCAL && process.env.NEXT_PUBLIC_DEV_BURNER !== "0";

  useEffect(() => {
    // hydrate persisted choices after mount (avoids SSR/CSR mismatch)
    const b = LS.get("perps.burner");
    if (b && burnerAllowed) { try { setBurner(JSON.parse(b, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v))); } catch { /* ignore */ } }
    setSubState(Number(LS.get("perps.sub") ?? 0) || 0);
    const ak = LS.get("perps.agentPk");
    if (ak) setAgentPk(ak as Hex);
    setUseAgentKeyState(LS.get("perps.useAgent") === "1");
    setUseRelayerState(LS.get("perps.useRelayer") === "1");
    setWantInjected(LS.get("perps.injected") !== "0"); // wagmi reconnects the wallet on load; without this flag the header showed "Connect wallet" after every reload
    setWantPrivy(LS.get("perps.privy") === "1");
    setReady(true);
  }, [burnerAllowed]);

  const burnerAcc = useMemo(() => (burner ? burnerAccount(burner) : undefined), [burner]);
  const burnerClient = useMemo(() => (burnerAcc ? createWalletClient({ account: burnerAcc, chain, transport: http(RPC_URL) }) : undefined), [burnerAcc]);

  const privyAcc = wantPrivy && privy.authenticated && privy.address && privy.provider ? privy.address : undefined;
  const privyClient = useMemo(() => (privyAcc && privy.provider ? createWalletClient({ account: privyAcc, chain, transport: custom(privy.provider) }) : undefined), [privyAcc, privy.provider]);

  const mode: Mode = burner ? "burner" : privyAcc ? "privy" : isConnected && wantInjected !== false && wagmiAddr ? "injected" : "none";
  const address = mode === "burner" ? burnerAcc!.address : mode === "privy" ? privyAcc : mode === "injected" ? wagmiAddr : undefined;
  const walletClient = mode === "burner" ? burnerClient : mode === "privy" ? privyClient : mode === "injected" ? (wagmiWallet as WalletClient | undefined) : undefined;

  const agentAccount = useMemo(() => (agentPk ? privateKeyToAccount(agentPk) : undefined), [agentPk]);
  const agentClient = useMemo(() => (agentAccount ? createWalletClient({ account: agentAccount, chain, transport: http(RPC_URL) }) : undefined), [agentAccount]);

  // relayer = Hardhat #9 (or #8 if the connected owner IS #9) so the submitting account is always different from the signer's owner
  const relayerAccount = useMemo(() => {
    if (!burnerAllowed) return undefined;
    const a9 = burnerAccount({ kind: "hardhat", index: 9 });
    return address && a9.address.toLowerCase() === address.toLowerCase() ? burnerAccount({ kind: "hardhat", index: 8 }) : a9;
  }, [burnerAllowed, address]);
  const relayerClient = useMemo(() => (relayerAccount ? createWalletClient({ account: relayerAccount, chain, transport: http(RPC_URL) }) : undefined), [relayerAccount]);
  const setUseRelayer = useCallback((v: boolean) => { setUseRelayerState(v); LS.set("perps.useRelayer", v ? "1" : "0"); }, []);

  const connectInjected = useCallback(() => {
    setConnectError(undefined);
    const c = connectors.find((x) => x.type === "injected") ?? connectors[0];
    if (!c) { setConnectError("No injected wallet found"); return; }
    setBurner(null); LS.set("perps.burner", null); setWantPrivy(false); LS.set("perps.privy", "0"); setWantInjected(true); LS.set("perps.injected", "1");
    connect({ connector: c, chainId: CHAIN_ID });
  }, [connect, connectors]);

  const connectEmail = useCallback(() => {
    setConnectError(undefined);
    setBurner(null); LS.set("perps.burner", null); wagmiDisconnect(); setWantInjected(false); LS.set("perps.injected", "0");
    setWantPrivy(true); LS.set("perps.privy", "1");
    if (!privy.authenticated) privy.login();
  }, [privy, wagmiDisconnect]);

  const connectBurner = useCallback((spec: BurnerSpec) => {
    if (!burnerAllowed) return;
    wagmiDisconnect();
    setBurner(spec);
    LS.set("perps.burner", JSON.stringify(spec, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  }, [burnerAllowed, wagmiDisconnect]);

  const disconnect = useCallback(() => { if (privy.authenticated) privy.logout(); setWantPrivy(false); LS.set("perps.privy", "0"); setBurner(null); LS.set("perps.burner", null); setWantInjected(false); LS.set("perps.injected", "0"); wagmiDisconnect(); }, [wagmiDisconnect, privy]);
  // A session key is authorized per subaccount: switching subaccount turns it off (the owner wallet signs until the user enables it again), otherwise orders would be blocked on a subaccount the key was never approved for.
  const setSub = useCallback((n: number) => { setSubState(n); LS.set("perps.sub", String(n)); setUseAgentKeyState(false); LS.set("perps.useAgent", "0"); }, []);
  const generateAgentKey = useCallback(() => { const k = generatePrivateKey(); setAgentPk(k); LS.set("perps.agentPk", k); }, []);
  const forgetAgentKey = useCallback(() => { setAgentPk(null); LS.set("perps.agentPk", null); setUseAgentKeyState(false); LS.set("perps.useAgent", "0"); }, []);
  const setUseAgentKey = useCallback((v: boolean) => { setUseAgentKeyState(v); LS.set("perps.useAgent", v ? "1" : "0"); }, []);

  const wrongChain = mode === "injected" && wagmiChain !== CHAIN_ID;
  const value: Ctx = {
    mode, address, walletClient, relayerAccount, relayerClient, useRelayer: useRelayer && !!relayerAccount, setUseRelayer, agentAccount, agentClient, useAgentKey: useAgentKey && !!agentAccount, setUseAgentKey, generateAgentKey, forgetAgentKey,
    sub, setSub, acct: address ? acctKey(address, sub) : undefined, burnerAllowed, connectInjected, connectBurner, disconnect,
    connectEmail: privy.enabled ? connectEmail : undefined, email: privy.email, mfaEnrolled: privy.mfaEnrolled, enrollMfa: privy.enabled ? privy.enrollMfa : undefined,
    wrongChain, switchChain: () => wagmiSwitch({ chainId: CHAIN_ID }), ready, connectError,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
