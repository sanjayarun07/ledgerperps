// Minimal dependency-free Prometheus exporter: chain head block + timestamp from a JSON-RPC endpoint.
// Env: RPC_URL (default http://chain:8545), PORT (default 9101)
const http = require("http");
const RPC = process.env.RPC_URL || "http://chain:8545";
const rpc = async (method) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "eth_getBlockByNumber" ? ["latest", false] : [] }) })).json()).result;
http.createServer(async (_req, res) => {
  let body = "";
  try {
    const b = await rpc("eth_getBlockByNumber");
    body += `# TYPE perps_chain_head_block gauge\nperps_chain_head_block ${parseInt(b.number, 16)}\n`;
    body += `# TYPE perps_chain_head_timestamp_seconds gauge\nperps_chain_head_timestamp_seconds ${parseInt(b.timestamp, 16)}\n`;
    body += `# TYPE perps_chain_up gauge\nperps_chain_up 1\n`;
  } catch (e) { body = `# TYPE perps_chain_up gauge\nperps_chain_up 0\n`; }
  res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(body);
}).listen(Number(process.env.PORT || 9101), () => console.log("chain-exporter listening"));
