// Run (wrapped by shoot.mjs): node scripts/dev/shoot.mjs --eval scripts/dev/mobile-audit.js --noshot --connect --size 375x812 --click "Long|Limit"
// Opens TP/SL, then checks: horizontal overflow/clipping inside the ticket and drawers, overlapping interactive boxes, input font size >= 16px
// on phones, touch targets >= 44px on phones, inputmode on text inputs.
return (async () => {
  const sw = document.querySelector('.tpsl input[role=switch]'); if (sw && !sw.checked) { sw.click(); await new Promise((r) => setTimeout(r, 400)); }
  for (const sc of document.querySelectorAll('.g-side, .g-side *, .drawer, [role=dialog]')) if (sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY)) sc.scrollTop = sc.scrollHeight; await new Promise((r) => setTimeout(r, 200));
  const vw = innerWidth, phone = vw < 768, out = { vw, overflow: [], overlap: [], small: [], font: [], inputmode: [] };
  const roots = [...document.querySelectorAll('.ticket, .g-side, .drawer, [role=dialog]')].filter((e) => e.getBoundingClientRect().width);
  const vis = (e) => { const d = e.closest('details:not([open])'); if (d && !e.closest('summary')) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = (e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}#${e.id}:${(e.textContent || e.id || '').trim().slice(0, 24)}`;
  for (const root of roots) {
    const rr = root.getBoundingClientRect();
    for (const e of root.querySelectorAll('*')) {
      if (!vis(e) || e.closest('.sr')) continue; const r = e.getBoundingClientRect();
      if (r.right > Math.min(rr.right, vw) + 1 || r.left < rr.left - 1) out.overflow.push(`clipped ${name(e)} ${Math.round(r.left)}-${Math.round(r.right)} in ${Math.round(rr.left)}-${Math.round(rr.right)}`);
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible' && e.children.length === 0 && e.tagName !== 'INPUT' && e.tagName !== 'SELECT' && e.clientWidth > 0) out.overflow.push(`text overflow ${name(e)}`);
    }
    const ctl = [...root.querySelectorAll('button, input:not([type=range]):not([type=checkbox]), select, a[href], [role=switch]')].filter((e) => vis(e) && !e.closest('.sr') && !e.closest('[hidden]'));
    for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
      if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue; const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 2 && iy > 2) out.overlap.push(`${name(ctl[i])} x ${name(ctl[j])}`);
    }
    for (const e of ctl) {
      const r = e.getBoundingClientRect();
      if (phone && r.height < 43.5 && !e.closest('.seg:not(.wide)') && !e.matches('.btn.link, .tip, .term-btn, [role=switch]') && !e.closest('.inp')) out.small.push(`${name(e)} h=${Math.round(r.height)}`);
      if (phone && (e.tagName === 'INPUT' || e.tagName === 'SELECT') && e.type !== 'checkbox' && parseFloat(getComputedStyle(e).fontSize) < 16) out.font.push(`${name(e)} ${getComputedStyle(e).fontSize}`);
      if (e.tagName === 'INPUT' && e.type === 'text' && !e.inputMode) out.inputmode.push(name(e));
    }
  }
  out.docOverflow = document.documentElement.scrollWidth > vw + 1;
  const n = (k) => out[k].length; out.summary = { overflow: n('overflow'), overlap: n('overlap'), small: n('small'), font: n('font'), inputmode: n('inputmode'), docOverflow: out.docOverflow };
  return JSON.stringify({ summary: out.summary, overflow: out.overflow.slice(0, 8), overlap: out.overlap.slice(0, 8), small: out.small.slice(0, 8), font: out.font.slice(0, 5) }, null, 1);
})()
