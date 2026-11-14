export const BANNER = `
========================================================================
  SIMULATED LIQUIDITY - NOT REAL
  Local-demo bots for an UNAUDITED prototype. Mock USDC, manual oracle.
  These orders are NOT real market activity and carry no real value.
========================================================================`;
export const printBanner = (name: string) => console.log(`${BANNER}\n  [${name}]\n`);
