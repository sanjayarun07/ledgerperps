#!/usr/bin/env bash
# Start/stop/status of the READ-ONLY testnet indexer (Arbitrum Sepolia). No key is involved; it only reads the chain.
#   infra/testnet/run-indexer.sh start|stop|status|reset      (reset = stop, drop and recreate the DB, start: use after a REDEPLOY)
# The indexer binary has no TLS, so https RPCs go through infra/testnet/rpc-proxy.js (local http forwarder with 429/5xx retry), started and stopped here too.
# Everything is overridable by env (none of these is a secret except a private RPC URL, which you pass in your shell, never in a file in git):
#   INDEXER_PROXY_GAP_MS / INDEXER_PROXY_CHUNK (default 100 / 50): for a rate-limited key (e.g. Alchemy free: 10-block eth_getLogs, compute-units-per-second cap) use INDEXER_BATCH=10 INDEXER_HDR_BATCH=5 INDEXER_PROXY_CHUNK=5 INDEXER_PROXY_GAP_MS=300
#   INDEXER_RPC_URL  (default public https://arbitrum-sepolia-rpc.publicnode.com: the official https://sepolia-rollup.arbitrum.io/rpc answered 429 to most indexer traffic, publicnode took 50-header batches without limiting; pass your own provider URL for fewer rate limits)
#   DEPLOYMENT       (default contracts/deployments/arbitrumSepolia.json: exchange, startBlock, chainId, market names)
#   START_BLOCK (default: startBlock from the deployment file)  INDEXER_PORT (18700)  INDEXER_DB (perps_testnet)  INDEXER_BIN  INDEXER_POLL_MS (1000)  INDEXER_BATCH (1000)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
export PATH=/opt/homebrew/bin:$HOME/.cargo/bin:$PATH
UPSTREAM="${INDEXER_RPC_URL:-https://arbitrum-sepolia-rpc.publicnode.com}"; PROXY_PORT="${PROXY_PORT:-18701}"; RPC="http://127.0.0.1:$PROXY_PORT"
DEP="${DEPLOYMENT:-$ROOT/contracts/deployments/arbitrumSepolia.json}"
PORT="${INDEXER_PORT:-18700}"; DB="${INDEXER_DB:-perps_testnet}"
BIN="${INDEXER_BIN:-$ROOT/frontend/.fe/cargo/release/perps-indexer}"
PIDF="$HERE/indexer.pid"; LOG="$HERE/indexer.log"; PPID_F="$HERE/rpc-proxy.pid"; PLOG="$HERE/rpc-proxy.log"
running() { [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" -o command= 2>/dev/null | grep -q perps-indexer; }
start() {
  running && { echo "already running, pid $(cat "$PIDF")"; return 0; }
  [ -x "$BIN" ] || { echo "indexer binary missing: $BIN (build: cd services/indexer && cargo build --release --locked, then set INDEXER_BIN)"; exit 1; }
  [ -f "$DEP" ] || { echo "deployment file missing: $DEP"; exit 1; }
  # two forwarders: :18701 for the indexer/keeper (100 ms upstream spacing, chunks of 50), :18702 for the browser UI (CORS, 1.5 s read cache, 50 ms spacing, chunks of 20, 4 calls in flight; the public RPC sends a duplicate CORS header the browser rejects)
  startproxy() { local pf="$HERE/$1.pid" port="$2" gap="$3" chunk="$4"
    if ! { [ -f "$pf" ] && ps -p "$(cat "$pf")" -o command= 2>/dev/null | grep -q rpc-proxy; }; then
      UPSTREAM_RPC_URL="$UPSTREAM" PROXY_PORT="$port" PROXY_MIN_GAP_MS="$gap" PROXY_CHUNK="$chunk" PROXY_CONCURRENCY="${5:-1}" nohup node "$HERE/rpc-proxy.js" > "$HERE/$1.log" 2>&1 < /dev/null & echo $! > "$pf"; sleep 1
    fi; }
  startproxy rpc-proxy "$PROXY_PORT" "${INDEXER_PROXY_GAP_MS:-100}" "${INDEXER_PROXY_CHUNK:-50}"; startproxy rpc-proxy-ui "${UI_PROXY_PORT:-18702}" 50 20 4
  psql -lqt postgres 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB" || createdb "$DB"
  # Arbitrum Sepolia: ~0.25 s blocks, sequencer-ordered, reorgs are rare and shallow; --reorg-window 600 (= 2.5 min of blocks) is the hash-walk page size;
  # --block-retention 2,000,000 (~6 days of block hashes) bounds how deep a reorg can be anchored. Parent-chain (Ethereum) finality of L2 blocks is NOT tracked: unknown/not handled.
  # Conservative on the public RPC: 1 s poll, 1000-block log batches, header batches of 50 with concurrency 1 (the public RPC answers 429 above ~40 per batch and on bursts; the forwarder also spaces upstream calls) with concurrency 2.
  START="${START_BLOCK:-$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('startBlock',0))" "$DEP")}"
  nohup "$BIN" --start-block "$START" --rpc-url "$RPC" --database-url "host=localhost user=$USER dbname=$DB" --deployment "$DEP" \
    --listen "127.0.0.1:$PORT" --poll-ms "${INDEXER_POLL_MS:-1000}" --batch "${INDEXER_BATCH:-1000}" --rpc-batch-size "${INDEXER_HDR_BATCH:-50}" --header-concurrency 1 \
    --reorg-window 600 --block-retention 2000000 --confirmations 0 --rate-rps 0 --ready-max-lag 40 \
    --cors-origins "http://localhost:3150,http://127.0.0.1:3150" > "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDF"; sleep 2; echo "started pid $(cat "$PIDF") on http://127.0.0.1:$PORT (log $LOG)"
}
stop() { for pf in "$HERE/rpc-proxy.pid" "$HERE/rpc-proxy-ui.pid"; do if [ -f "$pf" ] && ps -p "$(cat "$pf")" -o command= 2>/dev/null | grep -q rpc-proxy; then kill "$(cat "$pf")"; fi; rm -f "$pf"; done
  if running; then kill "$(cat "$PIDF")"; sleep 1; echo "stopped"; else echo "not running"; fi; rm -f "$PIDF"; }
status() {
  if running; then echo "running pid $(cat "$PIDF")"; else echo "not running"; fi
  curl -s -m 5 "http://127.0.0.1:$PORT/v1/status" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print({k:d.get(k) for k in ['chain_id','chain_head','indexed_head','lag_blocks','events_indexed','synced']})" 2>/dev/null || echo "API not answering on :$PORT"
}
case "${1:-status}" in
  start) start;; stop) stop;; status) status;;
  reset) stop; dropdb --if-exists "$DB"; createdb "$DB"; start;;
  *) echo "usage: $0 start|stop|status|reset"; exit 2;;
esac
