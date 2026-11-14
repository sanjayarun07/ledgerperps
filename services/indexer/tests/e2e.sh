#!/usr/bin/env bash
# End-to-end test: hardhat node -> deploy -> index LIVE while trading (incl. gap-move bad debt, ADL, recapitalisation)
# -> assert REST/WS vs contract ground truth -> restart from snapshot+tail -> wipe DB and re-index from scratch (must be
# identical) -> raw-log re-derivation after an ABI change (reindex-from-raw) -> API-key/CORS/rate-limit/Redis hardening
# -> reverted-tx tracker -> real chain reorg and a reorg deeper than --reorg-window (evm_revert).
# Requires: node, cargo, jq, curl, psql/createdb with a reachable local PostgreSQL; redis-server is optional (the Redis
# checks are skipped without it). Does not modify contracts/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$(cd "$HERE/../../contracts" && pwd)"
WORK="$HERE/.e2e"
HH="$CONTRACTS/node_modules/.bin/hardhat"
CFG="$HERE/scripts/hardhat.e2e.config.js"
DB="${E2E_DB:-perps_indexer_e2e}"
PGUSER_="${PGUSER:-$(whoami)}"
DBURL="host=localhost user=$PGUSER_ dbname=$DB"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
RPC_PORT="$(free_port)"; API_PORT="$(free_port)"
export E2E_RPC="http://127.0.0.1:$RPC_PORT" CONTRACTS_DIR="$CONTRACTS"
API="http://127.0.0.1:$API_PORT"
BIN="$HERE/target/debug/perps-indexer"
mkdir -p "$WORK"; rm -rf "$WORK/deployments" "$WORK"/*.json "$WORK"/*.log
NODE_PID=""; IDX_PID=""

REDIS_PID=""; REDIS_PORT=""
cleanup() {
  [ -n "$REDIS_PID" ] && kill "$REDIS_PID" 2>/dev/null || true
  [ -n "$IDX_PID" ] && kill "$IDX_PID" 2>/dev/null || true
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "E2E FAILED: $*"; echo "--- indexer log tail"; tail -n 30 "$WORK/indexer.log" 2>/dev/null || true; exit 1; }
step() { echo; echo "######## $*"; }

rpc_head() { printf '%d' "$(curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$E2E_RPC" | jq -r .result)"; }
# small snapshot interval / trade window / reorg window so snapshots, the Postgres trade history and deep reorgs are
# all exercised by a short test chain
COMMON_FLAGS=(--poll-ms 100 --ready-max-lag 2 --snapshot-every 20 --snapshot-keep 50 --mem-fills 5 --reorg-window 4 --enable-tx-tracker)
start_indexer_raw() { # args: extra flags (including any rate-limit flags)
  "$BIN" --rpc-url "$E2E_RPC" --database-url "$DBURL" --deployment "$WORK/deployments/localhost.json" --listen "127.0.0.1:$API_PORT" \
    "${COMMON_FLAGS[@]}" "$@" >>"$WORK/indexer.log" 2>&1 &
  IDX_PID=$!
}
start_indexer() { start_indexer_raw --rate-rps 0 "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
wait_ready() { for _ in $(seq 1 100); do [ "$(code "$API/readyz")" = "200" ] && return 0; sleep 0.1; done; fail "indexer never became ready"; }
stop_indexer() { kill "$IDX_PID" 2>/dev/null || true; wait "$IDX_PID" 2>/dev/null || true; IDX_PID=""; }
wait_sync() {
  for _ in $(seq 1 400); do
    h="$(rpc_head)"; i="$(curl -s "$API/v1/status" 2>/dev/null | jq -r '.data.indexed_head.number // empty' 2>/dev/null || true)"
    [ -n "$i" ] && [ "$h" = "$i" ] && return 0
    sleep 0.1
  done
  fail "indexer did not catch up (chain head=$(rpc_head))"
}

step "0. prerequisites"
for t in node cargo jq curl psql createdb dropdb python3; do command -v "$t" >/dev/null || fail "missing tool: $t"; done
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB" || fail "cannot create database $DB (is PostgreSQL running and reachable as $PGUSER_?)"
(cd "$HERE" && cargo build --locked 2>&1 | tail -n 2)

step "1. boot hardhat node on :$RPC_PORT and deploy"
(cd "$CONTRACTS" && "$HH" --config "$CFG" node --hostname 127.0.0.1 --port "$RPC_PORT" >"$WORK/node.log" 2>&1) &
NODE_PID=$!
for _ in $(seq 1 100); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$E2E_RPC" >/dev/null 2>&1 && break; sleep 0.3; done
[ "$(rpc_head)" -ge 0 ] || fail "node did not start"
(cd "$WORK" && "$HH" --config "$CFG" run "$CONTRACTS/scripts/deploy.js" --network localhost >"$WORK/deploy.log" 2>&1) || { cat "$WORK/deploy.log"; fail "deploy failed"; }
[ -f "$WORK/deployments/localhost.json" ] || fail "deployment json missing"
echo "deployed exchange $(jq -r .exchange "$WORK/deployments/localhost.json")"

step "2. start indexer BEFORE trading (live ingestion), run trading scenario"
start_indexer --wipe
wait_sync
export DEPLOYMENT="$WORK/deployments/localhost.json" EXPECTED="$WORK/expected.json" API
(cd "$WORK" && "$HH" --config "$CFG" run "$HERE/scripts/scenario.js" --network localhost) || fail "scenario failed"
wait_sync

step "3. assertions against contract ground truth (live index)"
node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_live.json" || fail "assertions failed"
echo "postgres: $(psql -At "$DB" -c 'select count(*) from events') events, $(psql -At "$DB" -c 'select count(distinct name) from events') distinct event types, $(psql -At "$DB" -c 'select count(*) from blocks') block hashes retained, $(psql -At "$DB" -c 'select count(*) from snapshots') snapshots"
[ "$(psql -At "$DB" -c 'select count(*) from events where raw_data is null or raw_topics is null')" = "0" ] || fail "some events are missing their raw topics/data"
echo "raw topics+data stored for every event"
[ "$(psql -At "$DB" -c 'select count(*) from snapshots')" -ge 3 ] || fail "expected periodic snapshots"
[ "$(psql -At "$DB" -c "select count(*) from events where name='Fill'")" -gt 5 ] || fail "scenario should have more fills than --mem-fills (5) so history comes from Postgres"
echo "$(psql -At "$DB" -c "select count(*) from events where name='Fill'") fills total vs a 5-fill in-memory window (older served via Postgres pagination, asserted by check.js)"
curl -s "$API/metrics" | grep -E '^indexer_(undecoded_events_total|snapshots_saved_total) ' || true

step "4. restart from snapshot + log tail (no wipe) => identical read models, replay bounded"
stop_indexer; start_indexer; wait_sync
M="$(curl -s "$API/metrics")"
SNAPB="$(echo "$M" | awk '/^indexer_last_replay_snapshot_block_plus_one /{print $2}')"; REPL="$(echo "$M" | awk '/^indexer_last_replay_events /{print $2}')"
echo "startup: snapshot block $((SNAPB-1)), replayed $REPL tail events"
[ "$SNAPB" -gt 1 ] || fail "restart did not use a snapshot (snapshot+1=$SNAPB replayed=$REPL)"
[ "$REPL" -lt "$(psql -At "$DB" -c 'select count(*) from events')" ] || fail "restart replayed the whole log"
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_resume.json" >/dev/null
diff -q "$WORK/dump_live.json" "$WORK/dump_resume.json" || fail "resume differs from live index"
echo "identical (live vs resumed)"

step "5. WIPE database, re-index from block 0 => identical read models (and assertions still pass)"
stop_indexer; start_indexer --wipe; wait_sync
node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_replay.json" >/dev/null || fail "assertions failed after wipe/re-index"
diff -q "$WORK/dump_live.json" "$WORK/dump_replay.json" || fail "wiped re-index differs from live index"
echo "identical (live vs full re-index); $(wc -c <"$WORK/dump_live.json") bytes of JSON compared"

step "6. raw logs: ABI lacking AdlExecuted/Recapitalized => stored raw as undecoded; reindex-from-raw re-derives them"
jq 'map(select(.type != "event" or (.name != "AdlExecuted" and .name != "Recapitalized")))' "$HERE/abi/PerpExchange.merged.json" >"$WORK/abi.stripped.json"
stop_indexer; start_indexer --wipe --abi-file "$WORK/abi.stripped.json"; wait_sync
UNDEC="$(curl -s "$API/metrics" | awk '/^indexer_undecoded_events_total /{print $2}')"
[ -n "$UNDEC" ] && [ "$UNDEC" -ge 2 ] || fail "expected undecoded events under the stripped ABI, got '$UNDEC'"
echo "stripped ABI: ingestion kept going; $UNDEC logs stored raw as Unknown:<topic0>"
stop_indexer
REIDX="$("$BIN" --database-url "$DBURL" reindex-from-raw)"; echo "$REIDX"
start_indexer; wait_sync
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_reindexed.json" >/dev/null
diff -q "$WORK/dump_live.json" "$WORK/dump_reindexed.json" || fail "after reindex-from-raw the read models differ from the live index"
echo "identical after reindex-from-raw (no RPC access needed to re-derive)"

step "7. security: API keys (hashed, read-only), CORS allowlist, per-key/per-IP limits, trusted proxy, Redis-shared limits"
stop_indexer
if command -v redis-server >/dev/null; then
  REDIS_PORT="$(free_port)"; redis-server --port "$REDIS_PORT" --save "" --appendonly no --bind 127.0.0.1 >"$WORK/redis.log" 2>&1 & REDIS_PID=$!
  for _ in $(seq 1 50); do redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break; sleep 0.1; done
else echo "(redis-server not installed: Redis-shared limit checks skipped)"; fi
KEY1="$("$BIN" --database-url "$DBURL" keys create --label e2e-main)"; K1="$(echo "$KEY1" | awk '/^key:/{print $2}')"; K1ID="$(echo "$KEY1" | awk '/^id:/{print $2}')"
KEY2="$("$BIN" --database-url "$DBURL" keys create --label e2e-tiny --rps 0.2 --burst 2)"; K2="$(echo "$KEY2" | awk '/^key:/{print $2}')"
[ -n "$K1" ] && [ -n "$K2" ] || fail "key creation failed"
SECRET1="${K1##*_}"
[ "$(psql -At "$DB" -c "select count(*) from api_keys where key_hash like '%$SECRET1%' or id like '%$SECRET1%' or label like '%$SECRET1%'")" = "0" ] || fail "plaintext key secret found in the database"
echo "created 2 keys; the secret itself is not stored (hash only)"
REDIS_FLAG=(); [ -n "$REDIS_PORT" ] && REDIS_FLAG=(--redis-url "redis://127.0.0.1:$REDIS_PORT")
start_indexer_raw --require-api-key --cors-origins https://app.example.com --key-refresh-secs 1 --trusted-proxies 127.0.0.1 --rate-rps 0.2 --rate-burst 2 --key-rate-rps 1000 --key-rate-burst 1000 "${REDIS_FLAG[@]}"
wait_ready
[ "$(code "$API/v1/status")" = "401" ] || fail "no key must be 401"
[ "$(code -H "X-API-Key: pk_00000000_deadbeef" "$API/v1/status")" = "401" ] || fail "bad key must be 401"
[ "$(code -H "X-API-Key: $K1" "$API/v1/status")" = "200" ] || fail "valid key must be 200"
[ "$(code -H "Authorization: Bearer $K1" "$API/v1/markets")" = "200" ] || fail "bearer key must be 200"
[ "$(code "$API/healthz")" = "200" ] || fail "healthz stays open"
echo "auth: missing/bad key 401, valid key 200 (header or bearer), ops endpoints open"
ACAO() { curl -s -D - -o /dev/null -H "X-API-Key: $K1" -H "Origin: $1" "$API/v1/status" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}'; }
[ "$(ACAO https://app.example.com)" = "https://app.example.com" ] || fail "configured origin must be echoed"
[ "$(ACAO http://localhost:3000)" = "http://localhost:3000" ] || fail "localhost origin allowed by default"
[ -z "$(ACAO https://evil.example)" ] || fail "foreign origin must get no CORS header"
echo "CORS: configured + localhost origins echoed, foreign origin denied"
R=""; for i in 1 2 3 4; do R="$R $(code -H "X-API-Key: $K2" "$API/v1/status")"; done
[ "$R" = " 200 200 429 429" ] || fail "per-key limit (burst 2) expected '200 200 429 429', got '$R'"
[ "$(code -H "X-API-Key: $K1" "$API/v1/status")" = "200" ] || fail "other key unaffected by the limited key"
echo "per-key limit:$R (other key unaffected)"
"$BIN" --database-url "$DBURL" keys revoke "$K1ID" >/dev/null
for _ in $(seq 1 40); do [ "$(code -H "X-API-Key: $K1" "$API/v1/status")" = "401" ] && break; sleep 0.25; done
[ "$(code -H "X-API-Key: $K1" "$API/v1/status")" = "401" ] || fail "revoked key still accepted"
echo "revoked key rejected within the refresh interval"
if [ -n "$REDIS_PORT" ]; then
  [ -n "$(redis-cli -p "$REDIS_PORT" keys '*')" ] || fail "no rate-limit buckets found in Redis"
  echo "Redis holds the shared buckets: $(redis-cli -p "$REDIS_PORT" keys '*' | tr '\n' ' ')"
fi
stop_indexer
[ -n "$REDIS_PORT" ] && redis-cli -p "$REDIS_PORT" flushall >/dev/null
start_indexer_raw --trusted-proxies 127.0.0.1 --rate-rps 0.2 --rate-burst 2 "${REDIS_FLAG[@]}"
wait_ready
R=""; for i in 1 2 3; do R="$R $(code -H "X-Forwarded-For: 203.0.113.7" "$API/v1/status")"; done
[ "$R" = " 200 200 429" ] || fail "per-IP limit via trusted X-Forwarded-For: expected ' 200 200 429', got '$R'"
[ "$(code -H "X-Forwarded-For: 203.0.113.8" "$API/v1/status")" = "200" ] || fail "different forwarded client must have its own bucket"
echo "per-IP limit keyed on the forwarded client (trusted proxy):$R; another client unaffected"
stop_indexer
[ -n "$REDIS_PORT" ] && redis-cli -p "$REDIS_PORT" flushall >/dev/null
start_indexer_raw --rate-rps 0.2 --rate-burst 2 "${REDIS_FLAG[@]}"   # no trusted proxies: X-Forwarded-For ignored
wait_ready
R=""; for i in 1 2 3; do R="$R $(code -H "X-Forwarded-For: 198.51.100.$i" "$API/v1/status")"; done
[ "$R" = " 200 200 429" ] || fail "untrusted peer must not be able to rotate X-Forwarded-For: got '$R'"
echo "untrusted peer rotating X-Forwarded-For is still limited as one client:$R"
if [ -n "$REDIS_PORT" ]; then
  kill "$REDIS_PID" 2>/dev/null || true; wait "$REDIS_PID" 2>/dev/null || true; REDIS_PID=""
  sleep 1; C="$(code "$API/v1/status")"
  [ "$C" = "200" ] || [ "$C" = "429" ] || fail "API must keep serving when Redis dies (got $C)"
  echo "Redis killed: API keeps answering from the in-memory fallback (HTTP $C)"
fi
stop_indexer; start_indexer; wait_sync

step "8. reverted-transaction visibility (opt-in receipt tracker)"
(cd "$WORK" && "$HH" --config "$CFG" run "$HERE/scripts/txtrack.js" --network localhost) || fail "tx tracker scenario failed"
wait_sync

step "9. real chain reorg (evm_snapshot / evm_revert) while indexing"
(cd "$WORK" && "$HH" --config "$CFG" run "$HERE/scripts/reorg.js" --network localhost) || fail "reorg scenario failed"
wait_sync
M="$(curl -s "$API/metrics")"
echo "reorg rebuild: snapshot block $(( $(echo "$M" | awk '/^indexer_last_replay_snapshot_block_plus_one /{print $2}') - 1 )), replayed $(echo "$M" | awk '/^indexer_last_replay_events /{print $2}') events"
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_after_reorg.json" >/dev/null
stop_indexer; start_indexer --wipe; wait_sync
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_after_reorg_replay.json" >/dev/null
diff -q "$WORK/dump_after_reorg.json" "$WORK/dump_after_reorg_replay.json" || fail "post-reorg incremental state differs from fresh re-index of the canonical chain"
echo "identical (post-reorg incremental vs fresh re-index of canonical chain)"

step "10. reorg DEEPER than --reorg-window (4): re-anchored beyond the window with an operator alert, not halted"
(cd "$WORK" && "$HH" --config "$CFG" run "$HERE/scripts/deepreorg.js" --network localhost) || fail "deep reorg scenario failed"
wait_sync
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_after_deep.json" >/dev/null
stop_indexer; start_indexer --wipe; wait_sync
DUMP_ONLY=1 node "$HERE/tests/check.js" "$API" "$EXPECTED" --dump "$WORK/dump_after_deep_replay.json" >/dev/null
diff -q "$WORK/dump_after_deep.json" "$WORK/dump_after_deep_replay.json" || fail "post-deep-reorg state differs from fresh re-index of the canonical chain"
echo "identical (post-deep-reorg incremental vs fresh re-index of canonical chain)"

step "E2E PASSED"
