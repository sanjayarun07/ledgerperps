// Dev tool: drives headless Chrome over CDP to take real full-resolution screenshots and run audits.
// Usage: node scripts/dev/shoot.mjs --out DIR [--host localhost|nova.localhost] [--theme dark|light] [--size 1440x900,375x812] [--connect] [--eval file.js] [--name tag]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "1"]] : acc), []));
const out = a.out ?? "."; mkdirSync(out, { recursive: true });
const host = a.host ?? "localhost", port = a.port ?? "3147", themes = (a.theme ?? "dark").split(","), sizes = (a.size ?? "1440x900").split(",");
const view = a.view ?? "trade", tag = a.name ?? "";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dbg = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), "shoot-"));
const ch = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver; for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json(); break; } catch { await sleep(200); } }
const tabs = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const evalSrc = a.eval ? readFileSync(a.eval, "utf8") : null;
const clicks = (a.click ?? "").split("|").filter(Boolean);
try {
  await send("Page.enable"); await send("Runtime.enable");
  for (const theme of themes) for (const sz of sizes) {
    const [w, h] = sz.split("x").map(Number); const mobile = w < 768;
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: a.dpr ? Number(a.dpr) : 1, mobile });
    await send("Page.navigate", { url: `http://${host}:${port}/` });
    await sleep(1500);
    await ev(`localStorage.setItem("terminal.theme","${theme}"); localStorage.setItem("terminal.tour.done", ${a.tour ? "null" : '"1"'}); ${a.tour ? 'localStorage.removeItem("terminal.tour.done");' : ""} 0`);
    await send("Page.navigate", { url: `http://${host}:${port}/` });
    await sleep(3500);
    if (a.connect) {
      await ev(`document.getElementById("connect-btn")?.click(); 0`); await sleep(300);
      await ev(`[...document.querySelectorAll('[role=menuitem]')].find(b=>/Hardhat #${a.acct ?? 1}/.test(b.textContent))?.click(); 0`); await sleep(3500);
    }
    if (view !== "trade") { await ev(`[...document.querySelectorAll('.navtab,.mnav button')].find(b=>b.textContent.trim().startsWith("${view[0].toUpperCase() + view.slice(1)}"))?.click(); 0`); await sleep(1500); }
    for (const c of clicks) { await ev(`[...document.querySelectorAll('button,[role=tab]')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(c)}))?.click(); 0`); await sleep(700); }
    if (evalSrc) { const r = await ev(`(async()=>{${evalSrc}})()`); console.log(`== ${theme} ${sz}`); console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1)); }
    if (!a.noshot) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const f = join(out, `${tag ? tag + "-" : ""}${host.startsWith("nova") ? "nova" : "default"}-${theme}-${sz}${view !== "trade" ? "-" + view : ""}.png`);
      writeFileSync(f, Buffer.from(r.data, "base64")); console.log("wrote", f);
    }
  }
} finally { ws.close(); ch.kill(); }
