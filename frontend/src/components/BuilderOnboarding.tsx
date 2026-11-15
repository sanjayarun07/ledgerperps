"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/lib/client";
import { CHAIN_ID, EXCHANGE, INDEXER_URL, NETWORK_KIND, RPC_URL, exchangeAbi } from "@/lib/config";
import { useWallet } from "@/lib/wallet";
import { PRIVY_APP_ID } from "@/lib/privy";
import { useBrand } from "@/brand/context";
import { EMPTY, STEPS, addressIssue, envFile, feeIssue, launchChecklist, marginBps, nameIssue, ownershipMessage, progress, revenueUsd, type BuilderState, type StepId } from "@/lib/builder";

const KEY = "perps.builder.v1";
const BLURB: Record<StepId, string> = {
  profile: "Name your venue and prove you own the wallet. No gas.",
  frontend: "Brand the terminal and export brand.config.json.",
  fees: "Plan your taker fee and see what you would earn.",
  revenue: "Choose the wallet that should receive earnings.",
  launch: "Final checks and the environment file for your deployment.",
};
const TITLES: Record<StepId, string> = { profile: "Create your builder profile", frontend: "Set up your front end", fees: "Set your fee model", revenue: "Set up revenue", launch: "Build and launch" };
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function load(): BuilderState {
  try { const v = localStorage.getItem(KEY); return v ? { ...EMPTY, ...(JSON.parse(v) as Partial<BuilderState>) } : EMPTY; } catch { return EMPTY; }
}

/** Operator onboarding. Everything is kept in this browser only; nothing is sent to a server and no fee is enforced on-chain (see the notes in each step). */
export default function BuilderOnboarding() {
  const w = useWallet();
  const { brand } = useBrand();
  const [s, setS] = useState<BuilderState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<StepId>("profile");
  const [msg, setMsg] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  useEffect(() => { const v = load(); setS(v); setLoaded(true); const first = STEPS.find((k) => progress(v, { exchangeBps: 5 })[k] === "todo"); if (first) setOpen(first); }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }, [s, loaded]);
  const set = (p: Partial<BuilderState>) => setS((x) => ({ ...x, ...p }));

  const fee = useQuery({
    queryKey: ["exchange-fees"],
    queryFn: async () => ({
      taker: Number(await publicClient.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "takerFeeBps" })),
      maker: Number(await publicClient.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "makerFeeBps" })),
    }),
    retry: 1,
  });
  const exchangeBps = fee.data?.taker ?? 5;
  const st = progress(s, { exchangeBps });
  const done = STEPS.filter((k) => st[k] === "done").length;

  const sign = async () => {
    setMsg(null);
    if (!w.walletClient || !w.address) { setMsg("Connect a wallet first (top right)."); return; }
    const issue = nameIssue(s.name);
    if (issue) { setMsg(issue); return; }
    setSigning(true);
    try {
      const message = ownershipMessage(s.name, w.address, window.location.origin, CHAIN_ID);
      const signature = await w.walletClient.signMessage({ account: w.address, message });
      set({ owner: w.address, signature, signedMessage: message, name: s.name.trim() });
      setMsg("Profile signed. This proves you control the wallet; it sent nothing on-chain.");
    } catch (e) { setMsg(`Not signed: ${(e as Error).message.split("\n")[0]}`); }
    finally { setSigning(false); }
  };
  const download = (name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const exportBrand = () => { download("brand.config.json", JSON.stringify(brand, null, 2), "application/json"); set({ brandExported: true }); };
  const margin = marginBps(s.planTakerBps, exchangeBps);
  const feeMsg = feeIssue(s.planTakerBps, exchangeBps);
  const checklist = launchChecklist(s);
  const env = envFile({ rpc: RPC_URL, chainId: CHAIN_ID, indexer: INDEXER_URL, privyAppId: PRIVY_APP_ID || undefined });

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 16, display: "grid", gap: 12 }}>
      <header>
        <h1 style={{ fontSize: 20, margin: 0 }}>Builder onboarding</h1>
        <p className="hint">Run your own branded front end on this exchange. Progress is saved in this browser only.</p>
        <div className="row" style={{ alignItems: "center", gap: 12 }} role="group" aria-label="Progress">
          <div role="progressbar" aria-label="Onboarding progress" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={done} style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }}><div style={{ width: `${(done / STEPS.length) * 100}%`, height: "100%", background: "var(--brand-fill)", transition: "width .2s" }} /></div>
          <span className="hint num" style={{ flex: "none" }}>{done} / {STEPS.length} completed</span>
        </div>
        <p className="callout warn">Testnet prototype. Contracts are unaudited. There is one exchange-wide fee: a builder fee is a plan, not something the contracts enforce or pay out yet.</p>
      </header>

      {STEPS.map((k, i) => (
        <section key={k} className="panel" aria-labelledby={`st-${k}`}>
          <h3 id={`st-${k}`} style={{ margin: 0 }}>
            <button type="button" className="btn" style={{ border: 0, background: "none", padding: 0, flex: 1, justifyContent: "flex-start", textAlign: "left", display: "grid", gap: 2, height: "auto", minHeight: 40 }} aria-expanded={open === k} onClick={() => setOpen(open === k ? ("" as StepId) : k)}>
              <span>{i + 1}. {TITLES[k]}</span>
              <span className="hint" style={{ fontWeight: 400 }}>{BLURB[k]}</span>
            </button>
            <span className={`chip ${st[k] === "done" ? "ok" : ""}`}>{st[k] === "done" ? "Done" : "To do"}</span>
          </h3>
          {open === k && (
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {k === "profile" && (<>
                <p className="hint">Connect a wallet at the top right first. Signing sends nothing on-chain.</p>
                <div className="field"><label htmlFor="bp-name">Builder name</label><div className="inp"><input id="bp-name" value={s.name} onChange={(e) => set({ name: e.target.value, signature: undefined })} /></div></div>
                {s.name && nameIssue(s.name) && <p className="errs" role="alert">{nameIssue(s.name)}</p>}
                <div className="field"><label htmlFor="bp-ref">Referral code (optional)</label><div className="inp"><input id="bp-ref" value={s.referralCode} onChange={(e) => set({ referralCode: e.target.value })} /></div></div>
                <p className="hint">Wallet: {w.address ?? "not connected"}</p>
                <button type="button" className="btn brand" disabled={signing} onClick={() => void sign()}>{signing ? "Waiting for your wallet..." : s.signature ? "Sign again" : "Verify wallet ownership"}</button>
                {s.signature && <p className="callout info">Signed by {s.owner}.</p>}
              </>)}
              {k === "frontend" && (<>
                <p className="hint">Your front end is this app with a brand file: name, logo, colours, markets and features. Open the Brand Studio, edit, then export <code>brand.config.json</code>. The export below saves the brand currently loaded ({brand.name}).</p>
                <div className="row wrap">
                  <a className="btn" href="/brand">Open Brand Studio</a>
                  <button type="button" className="btn brand" onClick={exportBrand}>Export brand.config.json</button>
                </div>
                <p className="hint">If /brand shows not found, the Studio is switched off: set <code>BRAND_STUDIO=1</code> on the server.</p>
              </>)}
              {k === "fees" && (<>
                <p className="hint">Exchange fee on-chain right now: taker {fee.data ? `${fee.data.taker} bps` : fee.isError ? "unavailable" : "loading"}, maker {fee.data ? `${fee.data.maker} bps` : "..."}. 1 bps = 0.01%.</p>
                <div className="row wrap">
                  <div className="field"><label htmlFor="fe-fee">Taker fee you plan to charge (bps)</label><div className="inp"><input id="fe-fee" inputMode="decimal" value={s.planTakerBps} onChange={(e) => set({ planTakerBps: Number(e.target.value) })} /></div></div>
                  <div className="field"><label htmlFor="fe-vol">Monthly taker volume (USD)</label><div className="inp"><input id="fe-vol" inputMode="numeric" value={s.planVolumeUsd} onChange={(e) => set({ planVolumeUsd: Number(e.target.value) })} /></div></div>
                </div>
                {feeMsg ? <p className="errs" role="alert">{feeMsg}</p> : <p className="callout info">Margin {margin} bps. On {usd(s.planVolumeUsd)} of taker volume that is {usd(revenueUsd(s.planVolumeUsd, margin))} a month before your costs.</p>}
                <p className="callout warn">This is a planning calculator. The contracts charge one exchange-wide fee and do not yet add or route a builder fee, so nothing here changes what traders pay.</p>
              </>)}
              {k === "revenue" && (<>
                <p className="hint">Where builder earnings should go once a fee-sharing contract exists. There is no setup fee and no payout today.</p>
                <div className="field"><label htmlFor="rv-addr">Payout wallet address</label><div className="inp"><input id="rv-addr" placeholder="0x..." value={s.payoutAddress} onChange={(e) => set({ payoutAddress: e.target.value.trim() })} /></div></div>
                {s.payoutAddress && addressIssue(s.payoutAddress) && <p className="errs" role="alert">{addressIssue(s.payoutAddress)}</p>}
                {w.address && <button type="button" className="btn sm" onClick={() => set({ payoutAddress: w.address! })}>Use connected wallet</button>}
              </>)}
              {k === "launch" && (<>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{checklist.map((c) => <li key={c.label}>{c.ok ? "Done" : "To do"}: {c.label}</li>)}</ul>
                <label className="check"><input type="checkbox" checked={s.testnetChecked} onChange={(e) => set({ testnetChecked: e.target.checked })} />I tried deposit, an order and a withdrawal on testnet (network: {NETWORK_KIND})</label>
                <h4>Environment for your deployment</h4>
                <pre className="hint" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{env}</pre>
                <button type="button" className="btn" onClick={() => download("builder.env.example", `${env}\n`, "text/plain")}>Download as .env example</button>
                <p className="hint">Deploy this front end with your brand file (see docs/WHITE_LABEL.md). Public values only: never put a private key in a front-end environment file. The RPC and indexer URLs above are this machine\u2019s local forwarders: replace them with your own endpoints.</p>
              </>)}
              <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                {i > 0 ? <button type="button" className="btn sm" style={{ flex: "none" }} onClick={() => setOpen(STEPS[i - 1]!)}>Back</button> : <span />}
                {i < STEPS.length - 1 && <button type="button" className="btn sm" style={{ flex: "none" }} onClick={() => setOpen(STEPS[i + 1]!)}>{st[k] === "done" ? "Next" : "Skip for now"}</button>}
              </div>
            </div>
          )}
        </section>
      ))}
      {msg && <p className="callout info" role="status">{msg}</p>}
      <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => { setS(EMPTY); setMsg("Cleared."); }}>Clear saved progress</button>
    </main>
  );
}
