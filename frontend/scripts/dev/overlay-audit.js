// Run (wrapped by shoot.mjs): node scripts/dev/shoot.mjs --eval scripts/dev/overlay-audit.js --noshot --connect --size 1440x900 -- opens Account drawer, close dialog, position detail and checks overflow/overlap.
const out = []; const sleep = (m) => new Promise((r) => setTimeout(r, m));
const vw = innerWidth;
async function audit(tag) {
  const roots = [...document.querySelectorAll('.drawer, [role=dialog], .modal > div, .overlay')].filter((e) => e.getBoundingClientRect().width);
  const bad = [];
  for (const root of roots) { const rr = root.getBoundingClientRect();
    for (const e of root.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (!r.width || e.closest('.sr')) continue; if (r.right > Math.min(rr.right, vw) + 1 || r.left < rr.left - 1) bad.push(e.tagName + '.' + String(e.className).split(' ')[0] + ':' + (e.textContent || '').trim().slice(0, 20)); }
    const ctl = [...root.querySelectorAll('button,input,select')].filter((e) => e.getBoundingClientRect().width && !e.closest('details:not([open])'));
    for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) { if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue; const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect(); if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) bad.push('overlap ' + (ctl[i].textContent || ctl[i].id).slice(0, 14) + ' x ' + (ctl[j].textContent || ctl[j].id).slice(0, 14)); } }
  out.push(tag + ': roots=' + roots.length + ' bad=' + bad.length + ' ' + bad.slice(0, 4).join(' | '));
}
const click = async (re, sel = 'button') => { const b = [...document.querySelectorAll(sel)].find((x) => re.test(x.textContent.trim()) && x.getBoundingClientRect().width); b?.click(); await sleep(700); return !!b; };
const esc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400); };
await click(/^Deposit$/); await audit('account-drawer'); await esc();
await click(/^Close$/, '.postable button, .cards button, td button'); await audit('close-dialog'); await esc();
await click(/^(BTC|ETH)-USD/, '.postable a, .postable button, td button, .cards button'); await audit('position-detail'); await esc();
return out.join('\n');
