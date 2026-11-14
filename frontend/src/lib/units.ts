// Pure unit helpers. price = 1e6, size = 1e8, USDC = 1e6, funding rate = 1e12 (=100%).
export const PRICE_DEC = 6;
export const SIZE_DEC = 8;
export const USDC_DEC = 6;
export const RATE_SCALE = 10n ** 12n;

const pow10 = (n: number) => 10n ** BigInt(n);

/** bigint -> plain decimal string with exactly up to `maxFrac` fractional digits (trailing zeros trimmed down to `minFrac`). */
export function formatFixed(v: bigint, dec: number, maxFrac = dec, minFrac = 0, group = false): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = pow10(dec);
  let whole = a / base;
  let frac = a % base;
  let fs = frac.toString().padStart(dec, "0");
  if (maxFrac < dec) {
    // round half up at maxFrac
    const unit = pow10(dec - maxFrac);
    const rounded = (a + unit / 2n) / unit; // in units of 10^-maxFrac
    const b2 = pow10(maxFrac);
    whole = rounded / b2;
    frac = rounded % b2;
    fs = maxFrac === 0 ? "" : frac.toString().padStart(maxFrac, "0");
  }
  while (fs.length > minFrac && fs.endsWith("0")) fs = fs.slice(0, -1);
  const ws = group ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole.toString();
  const isZero = whole === 0n && /^0*$/.test(fs);
  return `${neg && !isZero ? "-" : ""}${ws}${fs ? "." + fs : ""}`;
}

/** Strict decimal parse. Returns null for empty/invalid/too many decimals/negative. */
export function parseDecimal(s: string, dec: number): bigint | null {
  const t = s.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > dec) return null;
  return BigInt(w || "0") * pow10(dec) + BigInt(f.padEnd(dec, "0") || "0");
}

export const fmtPrice = (p: bigint, frac = 2) => formatFixed(p, PRICE_DEC, frac, frac, true);
export const fmtSize = (s: bigint, frac = 4) => formatFixed(s, SIZE_DEC, frac, 0, false);
export const fmtUsd = (v: bigint, frac = 2) => formatFixed(v, USDC_DEC, frac, frac, true);
export const fmtSigned = (v: bigint, dec: number, frac: number) => (v > 0n ? "+" : "") + formatFixed(v, dec, frac, frac, true);

/** notional in USDC 1e6 units: size(1e8) * price(1e6) / 1e8, floor. */
export const notionalFloor = (size: bigint, price: bigint) => (abs(size) * price) / pow10(SIZE_DEC);
export const notionalCeil = (size: bigint, price: bigint) => (abs(size) * price + pow10(SIZE_DEC) - 1n) / pow10(SIZE_DEC);

export const abs = (v: bigint) => (v < 0n ? -v : v);

/** funding rate (1e12 = 100%) -> percent string */
export function fmtRatePct(rate: bigint, frac = 4): string {
  // rate/1e12*100 => rate/1e10 percent
  return formatFixed(rate, 10, frac, frac) + "%";
}

export function fmtDuration(secs: number): string {
  if (secs < 0) secs = 0;
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = Math.floor(secs % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
