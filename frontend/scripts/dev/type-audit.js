// Run through: node scripts/dev/shoot.mjs --eval scripts/dev/type-audit.js --noshot --connect
// Computed-style audit of every visible text node: size / weight / family / tabular numerals against the documented type scale.
const SCALE = [10.5, 11.5, 12.25, 14, 16, 20, 28], WEIGHTS = [400, 500, 600];
const seen = new Map(), bad = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let n; let total = 0;
while ((n = walker.nextNode())) {
  const t = n.textContent.trim(); if (!t) continue;
  const el = n.parentElement; if (!el || el.closest("script,style,noscript,.sr")) continue;
  const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
  const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none") continue;
  total++;
  const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight), fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const tab = cs.fontVariantNumeric.includes("tabular-nums");
  const key = `${size}px/${weight}`; seen.set(key, (seen.get(key) ?? 0) + 1);
  const why = [];
  if (!SCALE.includes(size)) why.push(`size ${size} not in scale`);
  if (!WEIGHTS.includes(weight)) why.push(`weight ${weight}`);
  if (/\d/.test(t) && !tab) why.push("digits without tabular-nums");
  if (parseFloat(cs.letterSpacing) && Math.abs(parseFloat(cs.letterSpacing)) > 0.4 && size < 28) why.push(`letter-spacing ${cs.letterSpacing}`);
  if (cs.textTransform === "uppercase") why.push("uppercase");
  if (why.length) bad.push(`${why.join("; ")} :: <${el.tagName.toLowerCase()}.${(el.className + "").split(" ")[0]}> "${t.slice(0, 40)}"`);
}
const fonts = [...new Set([...document.querySelectorAll("body *")].filter((e) => e.childNodes.length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())).map((e) => getComputedStyle(e).fontFamily.split(",")[0].replace(/["']/g, "").trim()))];
const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`);
// panel header heights and control heights
const H = (sel) => [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
const ctl = {
  "panel headers (.phead/.booktop/.docktabs)": [...new Set(H(".phead, .booktop, .docktabs"))],
  "buttons .btn (non .sm)": [...new Set(H(".btn:not(.sm):not(.link):not(.iconsq)"))],
  "inputs .inp": [...new Set(H(".inp:not(.sm)"))],
};
return JSON.stringify({ textNodes: total, sizeWeightHistogram: Object.fromEntries([...seen].sort()), families: fonts, fontFacesLoaded: loaded, heights: ctl, violations: bad.length, firstViolations: bad.slice(0, 25) }, null, 1);
