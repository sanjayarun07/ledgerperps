#!/usr/bin/env bash
# Backfill benchmark: legacy one-request-per-header fetching vs JSON-RPC batching + concurrent prefetch.
# Boots a local hardhat node, deploys, mines N empty blocks (evm_mine; hardhat_mine writes zero parent hashes), then times
# a from-scratch index to the head for each configuration, directly against the node (0 ms) and through a delaying proxy
# (default 20 ms per HTTP request, a stand-in for a remote RPC provider).
# Every case indexes the whole chain from the deployment block (head column = blocks indexed, incl. deployment txs).
# usage: scripts/bench_headers.sh [BLOCKS=3000] [LATENCY_MS=20]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$(cd "$HERE/../../contracts" && pwd)"
WORK="$HERE/.bench"; HH="$CONTRACTS/node_modules/.bin/hardhat"; CFG="$HERE/scripts/hardhat.e2e.config.js"
N_LOCAL="${1:-3000}"; LAT="${2:-20}"
DB=perps_indexer_bench; DBURL="host=localhost user=${PGUSER:-$(whoami)} dbname=$DB"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
RPC_PORT="$(free_port)"; API_PORT="$(free_port)"; PROXY_PORT="$(free_port)"
export E2E_RPC="http://127.0.0.1:$RPC_PORT" CONTRACTS_DIR="$CONTRACTS"
BIN="$HERE/target/release/perps-indexer"
rm -rf "$WORK"; mkdir -p "$WORK"; PIDS=()
trap 'for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
(cd "$HERE" && cargo build --release --locked 2>&1 | tail -n 1)
(cd "$CONTRACTS" && "$HH" --config "$CFG" node --hostname 127.0.0.1 --port "$RPC_PORT" >"$WORK/node.log" 2>&1) & PIDS+=($!)
for _ in $(seq 1 100); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$E2E_RPC" >/dev/null 2>&1 && break; sleep 0.3; done
(cd "$WORK" && "$HH" --config "$CFG" run "$CONTRACTS/scripts/deploy.js" --network localhost >"$WORK/deploy.log" 2>&1)
node "$HERE/scripts/latency_proxy.js" "$PROXY_PORT" "$E2E_RPC" "$LAT" & PIDS+=($!)
mine() { # mine N blocks using JSON-RPC batches of 200 evm_mine calls
  node -e '
    const n = +process.argv[1], url = process.argv[2];
    (async () => { for (let done = 0; done < n; done += 200) {
      const b = []; for (let i = 0; i < Math.min(200, n - done); i++) b.push({ jsonrpc: "2.0", id: i + 1, method: "evm_mine", params: [] });
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
    } })();' "$1" "$E2E_RPC"
}
head_of() { printf '%d' "$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$E2E_RPC" | jq -r .result)"; }
run_case() { # name rpc-url flags...
  local name="$1" url="$2"; shift 2
  dropdb --if-exists "$DB" >/dev/null 2>&1; createdb "$DB"
  local target; target="$(head_of)"
  local t0; t0="$(python3 -c 'import time;print(time.time())')"
  "$BIN" --rpc-url "$url" --database-url "$DBURL" --deployment "$WORK/deployments/localhost.json" --listen "127.0.0.1:$API_PORT" \
    --poll-ms 50 --rate-rps 0 --wipe "$@" >"$WORK/idx.log" 2>&1 & local ip=$!
  for _ in $(seq 1 6000); do
    local cur; cur="$(curl -s "http://127.0.0.1:$API_PORT/v1/status" 2>/dev/null | jq -r '.data.indexed_head.number // empty' 2>/dev/null || true)"
    [ -n "$cur" ] && [ "$cur" = "$target" ] && break; sleep 0.05
  done
  local t1; t1="$(python3 -c 'import time;print(time.time())')"
  kill "$ip" 2>/dev/null || true; wait "$ip" 2>/dev/null || true
  python3 - "$name" "$target" "$t0" "$t1" <<'PY'
import sys; n,t,a,b=sys.argv[1],int(sys.argv[2]),float(sys.argv[3]),float(sys.argv[4])
print(f"{n:<46} {t:>6} blocks  {b-a:7.2f} s  {t/(b-a):8.0f} blocks/s")
PY
}
echo "case                                            head           time       rate"
mine "$N_LOCAL"
run_case "direct (0 ms): legacy 1 req/header" "$E2E_RPC" --rpc-batch-size 1 --header-concurrency 1 --no-prefetch
run_case "direct (0 ms): batch 100 + prefetch" "$E2E_RPC" --rpc-batch-size 100 --header-concurrency 4
echo "-- through a ${LAT} ms/request proxy"
run_case "proxy ${LAT} ms: legacy 1 req/header" "http://127.0.0.1:$PROXY_PORT" --rpc-batch-size 1 --header-concurrency 1 --no-prefetch
run_case "proxy ${LAT} ms: batch 100 + prefetch" "http://127.0.0.1:$PROXY_PORT" --rpc-batch-size 100 --header-concurrency 4
