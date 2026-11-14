"use client";
import { useEffect, useState } from "react";
import { parseEther, type Hex } from "viem";
import { useApp } from "@/lib/app";
import { EXCHANGE, IS_LOCAL, IS_TESTNET, MARKETS, NETWORK, USDC, usdcAbi } from "@/lib/config";
import { DEPOSIT_TEXT, depositStep } from "@/lib/network";
import { useAccountState, useAdlScores, useAgents, useChainClock, useEthBalance, usePositions, useSolvency, useSystem, useUsdc, useWithdrawGate } from "@/lib/queries";
import { effectiveLeverage, healthState } from "@/lib/risk";
import { useTx } from "@/lib/tx";
import { fmtPrice, fmtSize, fmtUsd, formatFixed, notionalFloor, parseDecimal, shortAddr } from "@/lib/units";
import { useWallet } from "@/lib/wallet";
import { Advanced, Empty, Row, Tip, Val } from "@/components/ui";
import { useBrand } from "@/brand/context";

export default function AccountPanel() {
  const w = useWallet();
  const { ticket } = useBrand();
  return (
    <>
      <Funds />
      {w.address && ticket.isolated && (
        <Advanced title="Margin mode: cross or isolated" hint="advanced" id="adv-margin"><IsoControls /></Advanced>
      )}
      {w.address && ticket.subaccounts && <Advanced title="Move money between subaccounts" hint="advanced" id="adv-transfer"><Transfer /></Advanced>}
      {w.address && ticket.sessionKeys && <Advanced title="Session keys" hint="trade without a wallet prompt" id="section-session"><Agents /></Advanced>}
      <Advanced title="Exchange safety: bad debt and auto-deleveraging" hint="advanced" id="adv-solvency"><Solvency /></Advanced>
    </>
  );
}

const SYMBOL = { safe: "✓", watch: "!", risk: "!!", liquidatable: "✕" } as const;
/** Account health: colour AND a text state AND a plain sentence. Ratio = equity / maintenance margin. */
export function HealthMeter({ equity, mm, label = "Account health" }: { equity: bigint | undefined; mm: bigint | undefined; label?: string }) {
  if (equity === undefined || mm === undefined) return <div className="health-box" aria-busy="true"><div className="health-top"><span>{label}</span><span className="skel" /></div></div>;
  const h = healthState(equity, mm);
  const fill = h.ratio === null ? 100 : Math.max(4, Math.min(100, Math.round(((h.ratio - 1) / 3) * 100)));
  const color = h.key === "safe" ? "var(--long)" : h.key === "watch" ? "var(--warn)" : "var(--short)";
  return (
    <div className={`health-box ${h.key}`} data-testid="health">
      <div className="health-top"><span><Tip k="mm">{label}</Tip></span><span className="state"><span aria-hidden>{SYMBOL[h.key]}</span>{h.label}</span></div>
      <div className="health" role="meter" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${h.label}${h.ratio !== null ? `, equity is ${h.ratio.toFixed(2)} times the maintenance margin` : ""}`} aria-label={label}><i style={{ width: `${fill}%`, background: color }} /></div>
      <p>{h.explain}{h.ratio !== null && ` (equity is ${h.ratio.toFixed(2)}x maintenance margin)`}</p>
    </div>
  );
}

function Funds() {
  const w = useWallet();
  const { send } = useTx();
  const acct = useAccountState(w.acct).data;
  const pos = usePositions(w.acct).data;
  const sys = useSystem().data;
  const usdc = useUsdc(w.address).data;
  const eth = useEthBalance(w.address).data;
  const gate = useWithdrawGate(w.acct).data;
  const [dep, setDep] = useState(""); const [wd, setWd] = useState(""); const [wdAck, setWdAck] = useState(false);
  if (!w.address) return (
    <div className="panel" id="account"><h3>Your account <span className="tag">Steps 1-2</span></h3>
      <Empty title="Connect a wallet to begin" body={IS_LOCAL ? "Then you can get mock USDC, deposit it, and place your first trade. Nothing is real money here." : "Then you can get test USDC from the faucet, deposit it, and place your first trade. Test funds only."} action={<button className="btn brand" onClick={() => document.getElementById("connect-btn")?.click()}>Connect wallet</button>} />
    </div>
  );

  const depAmt = parseDecimal(dep, 6); const wdAmt = parseDecimal(wd, 6);
  const gated = gate?.active === true && gate.principal !== null && wdAmt !== null && wdAmt > gate.principal;
  const needApprove = depAmt !== null && usdc !== undefined && usdc.allowance < depAmt;
  const notional = (pos ?? []).reduce((s, p) => { const mk = sys?.markets.find((m) => m.id === p.market)?.markPrice; return mk ? s + notionalFloor(p.size, mk) : s; }, 0n);
  const lev = acct ? effectiveLeverage(notional, acct.equity) : null;
  const blocked = w.wrongChain;
  const hasPos = (pos ?? []).some((p) => p.size !== 0n);
  const empty = !!acct && acct.collateral === 0n;
  // withdrawing to near the margin requirement is risky even when the contract allows it
  const after = acct && wdAmt ? healthState(acct.equity - wdAmt, acct.mm) : null;
  const wdRisky = !!after && acct!.mm > 0n && after.key !== "safe";
  const wdSevere = !!after && acct!.mm > 0n && (after.key === "risk" || after.key === "liquidatable");

  return (
    <div className="panel" id="account">
      <h3>Your account <span className="pill">subaccount {w.sub}</span></h3>
      <HealthMeter equity={acct?.equity} mm={acct?.mm} />
      <Row label="Equity" tip="equity"><Val v={acct && fmtUsd(acct.equity)} /> USDC</Row>
      <Row label="Available to trade" tip="available"><Val v={acct && fmtUsd(acct.avail)} /> USDC</Row>
      <Row label="Withdrawable" tip="withdrawable"><Val v={acct && fmtUsd(acct.withdrawable)} /> USDC</Row>
      <Advanced title="All account numbers">
        <Row label="Collateral deposited" tip="collateral"><Val v={acct && fmtUsd(acct.collateral)} /> USDC</Row>
        <Row label="Margin in use" tip="im"><Val v={acct && fmtUsd(acct.im)} /> USDC</Row>
        <Row label="Maintenance margin" tip="mm"><Val v={acct && fmtUsd(acct.mm)} /> USDC</Row>
        <Row label="Reserved for open orders"><Val v={acct && fmtUsd(acct.resv)} /> USDC</Row>
        <Row label="Leverage (all positions)" tip="leverage">{lev !== null ? `${lev.toFixed(2)}x` : "-"}</Row>
      </Advanced>

      <h4>Wallet</h4>
      <Row label={IS_LOCAL ? "Mock USDC in wallet" : "USDC in wallet"}><Val v={usdc && fmtUsd(usdc.bal)} /> USDC</Row>
      <Row label="Gas (native token)"><Val v={eth !== undefined ? formatFixed(eth, 18, 4) : undefined} /></Row>
      {eth !== undefined && eth === 0n && <p className="callout warn">This wallet has no gas tokens, so it cannot send transactions. {IS_LOCAL ? "Disconnect and connect a Hardhat dev account (they come with gas)." : IS_TESTNET ? `Get free test ETH for ${NETWORK.shortName} gas from a faucet, such as ${NETWORK.faucets?.eth?.[0]?.replace("https://", "")}.` : "Add some native tokens for network fees."}</p>}
      {IS_LOCAL && <button className="btn sm full" disabled={blocked} onClick={() => send({ label: "Get 10,000 mock USDC (local faucet)", address: USDC, abi: usdcAbi, functionName: "mint", args: [w.address, 10_000_000_000n] })}>Get 10,000 mock USDC (local faucet)</button>}

      {IS_TESTNET && NETWORK.faucets?.usdc && <p className="callout info faucet">Test funds only. <a href={NETWORK.faucets.usdc} target="_blank" rel="noopener noreferrer">Get test USDC from the Circle faucet</a>, and test ETH for gas from <a href={NETWORK.faucets.eth?.[0]} target="_blank" rel="noopener noreferrer">an {NETWORK.shortName} faucet</a>.</p>}
      <h4><Tip k="collateral">Deposit USDC</Tip></h4>
      {empty && <p className="callout info">Your account is empty. Deposit some USDC to start trading.</p>}
      <div className="row"><div className="inp"><input id="deposit-input" aria-label="Deposit amount in USDC" inputMode="decimal" placeholder="0.00" value={dep} onChange={(e) => setDep(e.target.value)} /><em>USDC</em></div>
        {needApprove ? (
          <button className="btn" style={{ flex: "none" }} disabled={blocked || !depAmt} onClick={() => send({ label: `Allow the exchange to use ${dep} USDC`, address: USDC, abi: usdcAbi, functionName: "approve", args: [EXCHANGE, depAmt] })}>Allow</button>
        ) : (
          <button className="btn brand" style={{ flex: "none" }} disabled={blocked || !depAmt || (usdc !== undefined && depAmt > usdc.bal)} onClick={() => send({ label: `Deposit ${dep} USDC to subaccount ${w.sub}`, functionName: "deposit", args: [w.address, w.sub, depAmt] }).then(() => setDep(""))}>Deposit</button>
        )}
      </div>
      <div className="quick">{[100, 1000].map((x) => <button key={x} type="button" className="btn sm" onClick={() => setDep(String(x))}>{x.toLocaleString("en-US")}</button>)}{usdc && usdc.bal > 0n && <button type="button" className="btn sm" onClick={() => setDep(formatFixed(usdc.bal, 6))}>All</button>}</div>
      {depAmt !== null && usdc && depAmt > usdc.bal && <p className="errs">You only have {fmtUsd(usdc.bal)} USDC in your wallet. {IS_LOCAL ? "Use the faucet above to get more." : "Enter a smaller amount."}</p>}
      {depAmt !== null && usdc !== undefined && <p className="hint" role="status">{DEPOSIT_TEXT[depositStep({ amount: depAmt, bal: usdc.bal, allowance: usdc.allowance })]}</p>}

      <h4><Tip k="withdrawable">Withdraw USDC</Tip></h4>
      {!hasPos && acct && acct.collateral > 0n && <p className="hint">You have no open positions, so your free collateral can be withdrawn.</p>}
      <div className="row"><div className="inp"><input id="withdraw-input" aria-label="Withdraw amount in USDC" inputMode="decimal" placeholder="0.00" value={wd} onChange={(e) => { setWd(e.target.value); setWdAck(false); }} /><em>USDC</em></div>
        <button className="btn" style={{ flex: "none" }} disabled={blocked || !wdAmt || gated || (acct !== undefined && wdAmt > acct.withdrawable) || (wdSevere && !wdAck)} onClick={() => send({ label: `Withdraw ${wd} USDC`, functionName: "withdraw", args: [w.sub, wdAmt], ctx: { principal: gate?.principal ?? undefined, fmtUsd } }).then(() => setWd(""))}>Withdraw</button></div>
      <div className="quick"><button type="button" className="btn sm" onClick={() => acct && setWd(formatFixed(acct.withdrawable, 6))}>Max ({acct ? fmtUsd(acct.withdrawable) : "-"})</button></div>
      {wdAmt !== null && acct && wdAmt > acct.withdrawable && <p className="errs">You can withdraw at most {fmtUsd(acct.withdrawable)} USDC. Margin in use, order reserves and unrealized profit stay locked until you close positions or cancel orders.</p>}
      {gate?.active === true && gate.principal !== null && <p className={gated ? "errs" : "hint"} data-testid="withdraw-gate">Withdrawals above your deposited amount are temporarily limited while the exchange has unresolved bad debt. You can withdraw up to {fmtUsd(gate.principal)} USDC.</p>}
      {wdRisky && acct && wdAmt !== null && wdAmt <= acct.withdrawable && (
        <div className="callout warn">
          Withdrawing {fmtUsd(wdAmt)} USDC would drop your account health to <b>{after!.label}</b>. {after!.explain}
          {wdSevere && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={wdAck} onChange={(e) => setWdAck(e.target.checked)} />I understand I may be liquidated.</label>}
        </div>
      )}
      <p className="hint">Withdraws send USDC from the exchange back to your wallet on this chain.</p>
    </div>
  );
}

function IsoControls() {
  const w = useWallet();
  const { market, name } = useApp();
  const { send } = useTx();
  const pos = usePositions(w.acct).data?.find((p) => p.market === market);
  const [amt, setAmt] = useState("");
  const a = parseDecimal(amt, 6);
  const iso = !!pos?.isolated;
  const flat = !pos || pos.size === 0n;
  const hs = pos && pos.isolated && pos.size !== 0n ? healthState(pos.iso.equity, pos.iso.mm) : null;
  const afterRemove = pos && a && iso && pos.size !== 0n ? healthState(pos.iso.equity - a, pos.iso.mm) : null;
  return (
    <>
      <p className="hint"><b>Cross</b> shares one pool of collateral across all positions. <b>Isolated</b> gives {name} its own margin, so the most you can lose on it is that margin. <Tip k="isolated" /></p>
      <div className="kv"><span>{name} is using</span><span className={`pill ${iso ? "iso" : "cross"}`}>{iso ? "isolated margin" : "cross margin"}</span></div>
      <div className="row">
        <button className="btn sm" disabled={iso || !flat} onClick={() => send({ label: `Use isolated margin for ${name}`, functionName: "setIsolated", args: [w.sub, market, true] })}>Switch to isolated</button>
        <button className="btn sm" disabled={!iso || !flat} onClick={() => send({ label: `Use cross margin for ${name}`, functionName: "setIsolated", args: [w.sub, market, false] })}>Switch to cross</button>
      </div>
      {!flat && <p className="hint">To switch, first close your {name} position and cancel its orders.</p>}
      {iso && pos && (
        <>
          {hs && hs.key !== "safe" && <div className="callout warn">This position&apos;s own margin is running low (<b>{hs.label}</b>). Add margin or close part of it. <button type="button" className="btn link" onClick={() => document.getElementById("iso-amt")?.focus()}>Add margin</button></div>}
          <Row label="Margin on this position">{fmtUsd(pos.iso.margin)} USDC</Row>
          <Row label="Equity on this position" tip="equity">{fmtUsd(pos.iso.equity)} USDC</Row>
          <Row label="Margin / maintenance" tip="mm">{fmtUsd(pos.iso.im)} / {fmtUsd(pos.iso.mm)}</Row>
          <div className="row" style={{ marginTop: 8 }}><div className="inp"><input id="iso-amt" aria-label="Isolated margin amount in USDC" inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} /><em>USDC</em></div></div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" disabled={!a} onClick={() => send({ label: `Add ${amt} USDC margin to ${name}`, functionName: "addIsoMargin", args: [w.sub, market, a] })}>Add margin</button>
            <button className="btn sm" disabled={!a} onClick={() => send({ label: `Remove ${amt} USDC margin from ${name}`, functionName: "removeIsoMargin", args: [w.sub, market, a] })}>Remove margin</button>
          </div>
          {afterRemove && afterRemove.key !== "safe" && <div className="callout warn">Removing {amt} USDC would leave this position at <b>{afterRemove.label}</b>. {afterRemove.explain}</div>}
          <p className="hint">Only your wallet can move margin; session keys cannot. You can remove margin only above what the position needs.</p>
        </>
      )}
    </>
  );
}

function Agents() {
  const w = useWallet();
  const { send } = useTx();
  const agentsQ = useAgents(w.acct);
  const agents = agentsQ.data ?? [];
  const clock = useChainClock();
  const [hours, setHours] = useState(24);
  const now = clock.now; // chain time: expiry is checked against block.timestamp, not the browser clock
  const mine = w.agentAccount?.address;
  const mineAuth = agents.find((x) => x.agent.toLowerCase() === mine?.toLowerCase());
  const mineActive = !!mineAuth && Number(mineAuth.expiry) > now;
  const loaded = agentsQ.data !== undefined;
  // an expired/revoked key must not stay selected as the trading signer: fall back to the owner wallet (checked against CHAIN time)
  useEffect(() => { if (loaded && clock.fromChain && w.useAgentKey && !mineActive) w.setUseAgentKey(false); }, [loaded, clock.fromChain, w, mineActive]);
  return (
    <div>
      <p className="hint">A session key is a temporary key kept in this browser that can place and cancel orders until it expires, so you are not asked to confirm every trade. It can never withdraw, transfer or change margin. <Tip k="session" /></p>
      {!mine ? <button className="btn sm" onClick={w.generateAgentKey}>Create a session key in this browser</button> : (
        <>
          <div className="kv"><span>Key</span><span className="num">{shortAddr(mine)}</span></div>
          <div className="kv"><span>Status</span><span>{mineActive ? `authorized until ${new Date(Number(mineAuth!.expiry) * 1000).toLocaleString()}` : "not authorized"}</span></div>
          <div className="row"><div className="inp"><input aria-label="Session key lifetime hours" type="number" min={1} value={hours} onChange={(e) => setHours(Number(e.target.value))} /><em>hours</em></div>
            <button className="btn sm" onClick={() => send({ label: `Authorize session key ${shortAddr(mine)} for ${hours} h`, functionName: "approveAgent", args: [w.sub, mine, BigInt(now + hours * 3600)] })}>Authorize</button></div>
          {IS_LOCAL && <button className="btn sm full" style={{ marginTop: 6 }} onClick={() => send({ label: "Send 0.05 ETH gas to session key", transfer: { to: mine, value: parseEther("0.05") } })}>Send the key 0.05 gas tokens (local)</button>}
          <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={w.useAgentKey} disabled={!mineActive} onChange={(e) => w.setUseAgentKey(e.target.checked)} />Trade with the session key (no wallet prompts)</label>
          <button className="btn sm danger" onClick={w.forgetAgentKey}>Forget key in this browser</button>
        </>
      )}
      {agents.length > 0 && <h4>Authorized keys on subaccount {w.sub}</h4>}
      {agents.map((x) => (
        <div className="kv" key={x.agent}><span className="num">{shortAddr(x.agent)} <span className="mute">{Number(x.expiry) > now ? "until " + new Date(Number(x.expiry) * 1000).toLocaleString() : "expired"}</span></span>
          <button className="btn sm danger" onClick={() => send({ label: `Revoke ${shortAddr(x.agent)}`, functionName: "revokeAgent", args: [w.sub, x.agent as Hex] })}>Revoke</button></div>
      ))}
    </div>
  );
}

const SUBS = Array.from({ length: 8 }, (_, i) => i);

/** transferInternal(fromSub, toSub, amount): moves free collateral between the connected owner's subaccounts. Owner-only (session keys cannot). */
function Transfer() {
  const w = useWallet();
  const { send } = useTx();
  const acct = useAccountState(w.acct).data;
  const [to, setTo] = useState(w.sub === 0 ? 1 : 0);
  const [amt, setAmt] = useState("");
  const dest = to === w.sub ? (w.sub === 0 ? 1 : 0) : to;
  const a = parseDecimal(amt, 6);
  const over = a !== null && acct !== undefined && a > acct.withdrawable;
  return (
    <div>
      <div className="kv"><span>From</span><span className="num">subaccount {w.sub} (selected in header)</span></div>
      <div className="row wrap" style={{ marginTop: 4 }}>
        <label className="row" style={{ flex: "none", gap: 6 }}><span className="mute">To</span>
          <span className="inp" style={{ width: 70 }}><select aria-label="Destination subaccount" value={dest} onChange={(e) => setTo(Number(e.target.value))}>{SUBS.filter((i) => i !== w.sub).map((i) => <option key={i} value={i}>{i}</option>)}</select></span></label>
        <div className="inp"><input aria-label="Transfer amount" inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} /><em>USDC</em></div>
        <button className="btn" disabled={w.wrongChain || !a || over} onClick={() => send({ label: `Transfer ${amt} USDC: subaccount ${w.sub} to ${dest}`, functionName: "transferInternal", args: [w.sub, dest, a] }).then((st) => { if (st === "executed") setAmt(""); })}>Transfer</button>
      </div>
      {over && <p className="errs">Exceeds withdrawable ({fmtUsd(acct!.withdrawable)}): margin in use and unrealized profit cannot be moved.</p>}
      <p className="hint">Moves collateral inside your wallet&apos;s own subaccounts without touching the token. Needs your wallet; a session key cannot transfer. The source must stay healthy.</p>
    </div>
  );
}

const MAX_SCORE = (1n << 256n) - 1n;
const fmtScore = (s: bigint | null) => (s === null ? "n/a (no mark)" : s === MAX_SCORE ? "max (equity <= 0)" : s === 0n ? "0 (not in profit)" : s.toString());

/** Solvency / ADL status: insurance, unresolved bad debt, per-market adlDebt, the connected account's adlScore, and recapitalize(). */
function Solvency() {
  const w = useWallet();
  const { send } = useTx();
  const sol = useSolvency().data;
  const scores = useAdlScores(w.acct).data;
  const pos = usePositions(w.acct).data;
  const usdc = useUsdc(w.address).data;
  const [amt, setAmt] = useState<Record<number, string>>({});
  if (!sol) return <p className="empty"><span className="skel" style={{ width: 160 }} /></p>;
  const debtMarkets = MARKETS.filter((m) => (sol.adlDebt[m.id] ?? 0n) > 0n);
  const status = sol.unresolvedBadDebt > 0n ? "bad" : debtMarkets.length ? "warn" : "ok";
  return (
    <div data-testid="solvency">
      <h3 style={{ fontSize: 13 }}><Tip k="baddebt">Status</Tip> <span className={`pill ${status === "ok" ? "cross" : "iso"}`} style={status === "bad" ? { color: "var(--short)", borderColor: "var(--short)" } : undefined}>{status === "ok" ? "no bad debt" : status === "warn" ? "ADL debt" : "UNRESOLVED BAD DEBT"}</span></h3>
      <div className="kv"><span>Insurance fund</span><span className="num">{fmtUsd(sol.insurance)} USDC</span></div>
      <div className="kv"><span>Unresolved bad debt</span><span className={`num ${sol.unresolvedBadDebt > 0n ? "short" : ""}`}>{fmtUsd(sol.unresolvedBadDebt)} USDC</span></div>
      {MARKETS.map((m) => {
        const debt = sol.adlDebt[m.id] ?? 0n;
        const a = parseDecimal(amt[m.id] ?? "", 6);
        const need = a !== null && usdc !== undefined && usdc.allowance < a;
        return (
          <div key={m.id}>
            <div className="kv"><span>ADL debt {m.name}</span><span className={`num ${debt > 0n ? "short" : ""}`}>{fmtUsd(debt)} USDC</span></div>
            {debt > 0n && w.address && (
              <div className="row" style={{ margin: "2px 0 6px" }}>
                <div className="inp"><input aria-label={`Recapitalize ${m.name} amount`} inputMode="decimal" placeholder={formatFixed(debt, 6)} value={amt[m.id] ?? ""} onChange={(e) => setAmt({ ...amt, [m.id]: e.target.value })} /><em>USDC</em></div>
                <button className="btn sm" onClick={() => setAmt({ ...amt, [m.id]: formatFixed(debt, 6) })}>Full</button>
                {need
                  ? <button className="btn sm" disabled={w.wrongChain} onClick={() => send({ label: `Approve ${amt[m.id]} tUSDC for recapitalize`, address: USDC, abi: usdcAbi, functionName: "approve", args: [EXCHANGE, a] })}>Approve</button>
                  : <button className="btn sm brand" disabled={w.wrongChain || !a || a <= 0n || (usdc !== undefined && a > usdc.bal)} onClick={() => send({ label: `Recapitalize ${m.name} ${amt[m.id]} USDC`, functionName: "recapitalize", args: [m.id, a] }).then((st) => { if (st === "executed") setAmt({ ...amt, [m.id]: "" }); })}>Recapitalize</button>}
              </div>
            )}
          </div>
        );
      })}
      {debtMarkets.length > 0 && <p className="hint">Recapitalize repays ADL debt from your wallet USDC (anyone can). Until it is cleared or a keeper runs ADL against profitable opposite-side positions, withdrawals can be physically undercollateralized. Amounts above the debt are capped by the contract.</p>}
      {w.address && (
        <>
          <h4>Your ADL rank (subaccount {w.sub})</h4>
          {(pos ?? []).filter((p) => p.size !== 0n).length === 0 ? <p className="hint">No open position: nothing to deleverage.</p> : (pos ?? []).filter((p) => p.size !== 0n).map((p) => (
            <div className="kv" key={p.market}><span>{MARKETS[p.market].name} {p.size > 0n ? "long" : "short"} {fmtSize(p.size < 0n ? -p.size : p.size, 4)}</span><span className="num">{fmtScore(scores?.find((s) => s.market === p.market)?.score ?? null)}</span></div>
          ))}
          <p className="hint">Score = unrealized PnL % of entry notional x leverage (bps). Higher scores are deleveraged first; a position that is not in profit is never ADL&apos;d.</p>
        </>
      )}
      <h4>Recent events ({sol.source === "indexer+chain" ? "indexer" : "chain log window"})</h4>
      {sol.events.length === 0 ? <p className="hint">No liquidation bad debt, ADL or recapitalization events seen.</p> : sol.events.slice(0, 6).map((e) => (
        <div className="kv" key={`${e.txHash}${e.kind}${e.block}`}><span>{e.kind.replace(/_/g, " ")}{e.market !== null ? ` ${MARKETS[e.market]?.name ?? "#" + e.market}` : ""}{e.price ? ` @ ${fmtPrice(e.price)}` : ""}</span><span className="num">{fmtUsd(e.amount)}</span></div>
      ))}
    </div>
  );
}
