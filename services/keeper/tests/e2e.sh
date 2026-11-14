#!/usr/bin/env bash
# End-to-end test: boots a hardhat node, deploys the exchange (+ a Multicall3 stand-in at the canonical address),
# creates an underwater account and asserts the Rust keeper (a) waits on a stale oracle, (b) dry-runs without sending,
# (c) skips an unprofitable liquidation unless forced, (d) liquidates, (e) fires conditional + TWAP, (f) survives a chain
# reorg (evm_snapshot/evm_revert), (g) runs ADL, (h) exposes health/metrics, refuses a second process on the same
# checkpoint, and shuts down gracefully. Also covers --config TOML, JSON logs, per-market funding cadence, --send-raw-via,
# Multicall3 and the no-Multicall fallback. Requires: node, npx, cargo, curl.
# Nothing under ../../contracts is modified (hardhat is driven by scripts/hardhat.e2e.config.js; outputs go to a temp dir).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEPER_DIR="$(cd "$HERE/.." && pwd)"
CONTRACTS="$(cd "$KEEPER_DIR/../../contracts" && pwd)"
export E2E_PORT="${E2E_PORT:-18545}"
METRICS_PORT="${E2E_METRICS_PORT:-19100}"
TMP="$(mktemp -d)"
export E2E_OUT="$TMP/deploy.json"
RPC="http://127.0.0.1:$E2E_PORT"
# Well-known hardhat dev account #4 (public test key; holds only test ETH on the local node)
export KEEPER_PRIVATE_KEY="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
BIN="$KEEPER_DIR/target/debug/perp-keeper"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  # `npx hardhat node` leaves a grandchild node process listening on the port: stop whatever we started on OUR port
  [ -n "${NODE_STARTED:-}" ] && { lsof -ti "tcp:$E2E_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; }
  echo "logs kept in $TMP"
}
trap cleanup EXIT

hh() { (cd "$CONTRACTS" && E2E_PHASE="$1" npx hardhat --config "$KEEPER_DIR/scripts/hardhat.e2e.config.js" run --no-compile "$KEEPER_DIR/scripts/e2e-chain.js" --network localhost); }
phase() { echo "--- phase: $1"; hh "$1"; }
die() { echo "E2E FAIL: $*"; echo "--- keeper log tail"; tail -n 40 "$TMP"/keeper*.log 2>/dev/null || true; exit 1; }

start_keeper_raw() { # $1=name, rest=ALL args (nothing is added)
  local name="$1"; shift
  "$BIN" "$@" >"$TMP/keeper-$name.log" 2>&1 &
  KPID=$!; PIDS+=("$KPID")
  sleep 2
  kill -0 "$KPID" 2>/dev/null || die "keeper $name exited early"
}
start_keeper() { # $1=name, rest=extra args. NOTE: no --funding-interval-secs: cadence comes from each market's fundingInterval
  local name="$1"; shift
  start_keeper_raw "$name" --rpc-url "$RPC" --exchange "$EXCHANGE" --start-block 0 --poll-interval-ms 500 \
    --metrics-addr "127.0.0.1:$METRICS_PORT" --tx-timeout-secs 20 --log-format text "$@"
}
rpc() { curl -fsS -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"; }
wait_metric() { # name op value secs   e.g. wait_metric keeper_reorgs_total -ge 1 30
  local end=$((SECONDS + $4)); while [ $SECONDS -lt $end ]; do local v; v="$(metric "$1" || true)"; [ -n "$v" ] && [ "$v" "$2" "$3" ] && return 0; sleep 0.5; done
  die "timeout waiting for $1 $2 $3 (last: $(metric "$1" || echo none))"
}
stop_keeper() { kill -TERM "$KPID"; for _ in $(seq 1 20); do kill -0 "$KPID" 2>/dev/null || return 0; sleep 0.5; done; die "keeper did not exit on SIGTERM"; }
metric() { curl -fsS "http://127.0.0.1:$METRICS_PORT/metrics" | awk -v n="$1" 'index($0, n " ")==1 || index($0, n)==1 && substr($0, length(n)+1, 1)=="{" {print $NF; exit}'; }

echo "== build keeper"; (cd "$KEEPER_DIR" && cargo build --quiet)

echo "== start hardhat node on :$E2E_PORT"
if lsof -ti "tcp:$E2E_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $E2E_PORT is busy (set E2E_PORT)"; exit 2; fi
NODE_STARTED=1
(cd "$CONTRACTS" && npx hardhat --config "$KEEPER_DIR/scripts/hardhat.e2e.config.js" node --port "$E2E_PORT" >"$TMP/node.log" 2>&1) &
PIDS+=("$!")
for _ in $(seq 1 60); do
  curl -fsS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null || die "hardhat node did not start (see $TMP/node.log)"

phase deploy
EXCHANGE="$(node -e "console.log(require('$E2E_OUT').exchange)")"
echo "exchange=$EXCHANGE"

echo "== install a Multicall3 stand-in at the canonical address (hardhat nodes have none)"
export E2E_MC_OUT="$TMP/mc-build"
(cd "$KEEPER_DIR" && "$CONTRACTS/node_modules/.bin/hardhat" --config scripts/hardhat.multicall.config.js compile >"$TMP/mc-compile.log" 2>&1) || { cat "$TMP/mc-compile.log"; die "could not compile Multicall3Lite"; }
MC_CODE="$(node -e "console.log(require('$E2E_MC_OUT/artifacts/scripts/sol/Multicall3Lite.sol/Multicall3Lite.json').deployedBytecode)")"
rpc hardhat_setCode "[\"0xcA11bde05977b3631167028862bE2a173976CA11\",\"$MC_CODE\"]" | grep -q '"result":true' || die "hardhat_setCode failed"
echo "ASSERT OK: Multicall3 code installed"

echo "== keeper #1 (live): healthy market, nothing to liquidate; pokes funding once per market (market fundingInterval=3600s); discovers accounts"
start_keeper one --state-file "$TMP/state.json"
sleep 5
curl -fsS "http://127.0.0.1:$METRICS_PORT/healthz" | grep -q ok || die "/healthz"
curl -fsS "http://127.0.0.1:$METRICS_PORT/readyz" | grep -q ready || die "/readyz not ready"
[ "$(metric keeper_accounts_tracked)" -ge 2 ] || die "expected >=2 tracked accounts, got $(metric keeper_accounts_tracked)"
grep -q "poke_funding" "$TMP/keeper-one.log" || die "no pokeFunding tx observed"
grep -q "read batching: Multicall3" "$TMP/keeper-one.log" || die "keeper did not detect/use Multicall3"
[ "$(metric keeper_multicall_enabled)" = "1" ] || die "keeper_multicall_enabled != 1"
echo "ASSERT OK: Multicall3 auto-detected and used"
# per-market cadence: 2 markets x 1 poke, NOT one poke every few seconds
PK="$(metric 'keeper_txs_sent_total{kind="poke_funding"}')"
[ "$PK" = "2" ] || die "expected exactly 2 poke_funding txs in the first ~5s (one per market, interval 3600s), got '$PK'"
echo "ASSERT OK: funding poked once per market (per-market fundingInterval respected)"
phase assert-idle

echo "== a second keeper on the same checkpoint must be refused (lock file)"
set +e
"$BIN" --rpc-url "$RPC" --exchange "$EXCHANGE" --state-file "$TMP/state.json" --metrics-addr "127.0.0.1:19101" --dry-run >"$TMP/keeper-dup.log" 2>&1
RC=$?
set -e
[ "$RC" != "0" ] || die "second keeper on the same state file started!"
grep -q "in use by another keeper process" "$TMP/keeper-dup.log" || die "no lock message: $(cat "$TMP/keeper-dup.log")"
echo "ASSERT OK: second process refused (exit $RC)"

echo "== STALE oracle: account is 'underwater' on paper but the keeper must wait"
phase stale
sleep 4
phase assert-idle
[ "$(metric keeper_oracle_waits_total)" -ge 1 ] || die "oracle_waits not incremented"
[ "$(metric keeper_liquidations_sent_total)" = "0" ] || die "keeper liquidated on a stale oracle!"
grep -qi "oracle" "$TMP/keeper-one.log" || die "no oracle wait logged"
stop_keeper
grep -q "keeper stopped" "$TMP/keeper-one.log" || die "no graceful shutdown message"
[ -s "$TMP/state.json" ] || die "checkpoint not written"
echo "ASSERT OK: graceful SIGTERM shutdown + checkpoint written"
node -e "const s=require('$TMP/state.json'); if(!s.hashes||Object.keys(s.hashes).length<1) process.exit(1); console.log('checkpoint stores', Object.keys(s.hashes).length, 'block hashes for reorg detection')" || die "checkpoint has no block hashes"

echo "== fresh crash price, keeper #2 in DRY-RUN with Multicall disabled (parallel-call fallback): must simulate but never send"
phase crash
start_keeper two --dry-run --multicall off --state-file "$TMP/state-dry.json"
sleep 4
phase assert-idle
grep -q "DRY-RUN.*liquidate" "$TMP/keeper-two.log" || die "dry-run keeper never reported a would-send"
grep -q "kind=\"liquidate\"\|liquidate" "$TMP/keeper-two.log" || die "dry-run did not consider liquidation"
grep -q "parallel eth_calls" "$TMP/keeper-two.log" || die "--multicall off did not use the fallback path"
grep -q "profitability check passed" "$TMP/keeper-two.log" || die "no profitability decision logged"
echo "ASSERT OK: dry-run simulated liquidation and sent nothing (fallback read path, profitable at \$3000/ETH)"
stop_keeper

echo "== keeper #2b (dry-run): gas priced absurdly high => liquidation is UNPROFITABLE and skipped"
start_keeper twob --dry-run --native-usd-price 1000000000 --state-file "$TMP/state-dry-b.json"
sleep 4
grep -q "SKIPPING: estimated gas cost exceeds keeper reward" "$TMP/keeper-twob.log" || die "unprofitable liquidation not skipped"
! grep -q "DRY-RUN.*liquidate" "$TMP/keeper-twob.log" || die "unprofitable liquidation still reached the send path"
[ "$(metric 'keeper_skipped_unprofitable_total{kind="liquidate"}')" -ge 1 ] || die "skipped_unprofitable metric missing"
echo "ASSERT OK: unprofitable liquidation skipped"
stop_keeper
echo "== keeper #2c (dry-run) same prices + --force-unprofitable => proceeds"
start_keeper twoc --dry-run --native-usd-price 1000000000 --force-unprofitable --state-file "$TMP/state-dry-c.json"
sleep 4
grep -q "DRY-RUN.*liquidate" "$TMP/keeper-twoc.log" || die "--force-unprofitable did not override the gate"
echo "ASSERT OK: --force-unprofitable overrides"
stop_keeper
phase assert-idle

echo "== keeper #3 (live) configured via --config TOML + JSON logs + private raw-tx endpoint; resumes from keeper #1's checkpoint and liquidates"
cat >"$TMP/keeper3.toml" <<EOF
rpc_url = "$RPC"
exchange = "$EXCHANGE"
start_block = 0
poll_interval_ms = 500
metrics_addr = "127.0.0.1:$METRICS_PORT"
tx_timeout_secs = 20
log_format = "json"
reorg_window = 64
EOF
start_keeper_raw three --config "$TMP/keeper3.toml" --state-file "$TMP/state.json" --send-raw-via "$RPC"
grep -q "resumed from checkpoint" "$TMP/keeper-three.log" || die "did not resume from checkpoint"
phase assert-liquidated
[ "$(metric keeper_liquidations_sent_total)" = "1" ] || die "liquidations_sent != 1 (got $(metric keeper_liquidations_sent_total))"
echo "ASSERT OK: keeper_liquidations_sent_total = 1 (signed locally, broadcast via --send-raw-via)"
node -e "
const lines=require('fs').readFileSync('$TMP/keeper-three.log','utf8').split('\n').filter(Boolean);
let bad=lines.filter(l=>{try{JSON.parse(l);return false}catch(e){return true}});
if(bad.length||!lines.length){console.error('non-JSON log lines:',bad.slice(0,3));process.exit(1)}
console.log('ASSERT OK:', lines.length, 'log lines, all valid JSON (log_format from TOML)');" || die "JSON logs"
grep -q "mined" "$TMP/keeper-three.log" || die "no tx mined log"

echo "== conditional order + TWAP"
phase extras
phase pump
phase assert-extras

echo "== REORG: a deposit is discovered, then evm_revert removes it; the keeper must roll back to the common ancestor"
sleep 2
BEFORE="$(metric keeper_accounts_tracked)"
SNAP="$(rpc evm_snapshot '[]' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).result))")"
echo "snapshot=$SNAP accounts_before=$BEFORE"
phase reorg-deposit
wait_metric keeper_accounts_tracked -eq $((BEFORE + 1)) 30
echo "keeper discovered the new account (tracked=$(metric keeper_accounts_tracked))"
rpc evm_revert "[\"$SNAP\"]" | grep -q '"result":true' || die "evm_revert failed"
phase reorg-replace
wait_metric keeper_reorgs_total -ge 1 30
wait_metric keeper_accounts_tracked -eq "$BEFORE" 30
grep -q "reorg handled" "$TMP/keeper-three.log" || die "no reorg log"
[ "$(metric keeper_liquidations_sent_total)" = "1" ] || die "reorg disturbed liquidation count"
echo "ASSERT OK: reorg detected (keeper_reorgs_total=$(metric keeper_reorgs_total)); account from the orphaned block was forgotten"

echo "== ADL: gap move -> bad debt -> keeper deleverages the profitable counterparty"
phase adl-setup
phase assert-adl
grep -q "kind\":\"adl\"\|adl executed" "$TMP/keeper-three.log" || echo "(note: adl log line not matched; chain assertion above is authoritative)"
stop_keeper
echo
echo "E2E PASSED"
