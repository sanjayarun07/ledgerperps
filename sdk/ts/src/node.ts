import type { Deployment } from "./types.js";

/** Loads contracts/deployments/<network>.json (Node only). */
export async function loadDeployment(path: string): Promise<Deployment> {
  const fs = await import("node:fs/promises");
  const d = JSON.parse(await fs.readFile(path, "utf8")) as Deployment;
  if (!d.exchange || !d.usdc || !d.oracle || !d.chainId) throw new Error(`invalid deployment file ${path}`);
  return d;
}
