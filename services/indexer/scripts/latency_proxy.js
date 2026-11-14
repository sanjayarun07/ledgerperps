// Tiny JSON-RPC pass-through proxy that adds a fixed delay to every HTTP request (a stand-in for a remote RPC node).
// usage: node latency_proxy.js <listen-port> <upstream-url> <delay-ms>
const http = require("http");
const [port, upstream, delay] = [Number(process.argv[2]), new URL(process.argv[3]), Number(process.argv[4] || 20)];
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        const up = http.request({ host: upstream.hostname, port: upstream.port, path: "/", method: "POST", headers: { "content-type": "application/json" } }, (r) => {
          res.writeHead(r.statusCode, { "content-type": "application/json" });
          r.pipe(res);
        });
        up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
        up.end(Buffer.concat(chunks));
      }, delay);
    });
  })
  .listen(port, "127.0.0.1");
