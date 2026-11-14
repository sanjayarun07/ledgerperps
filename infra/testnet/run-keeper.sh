#!/usr/bin/env bash
# Keeper for Arbitrum Sepolia. Default = DRY-RUN (no signer, no key, no transactions).  infra/testnet/run-keeper.sh start|stop|status
# Reads exchange and start block from contracts/deployments/arbitrumSepolia.json (override: DEPLOYMENT=...). Needs the RPC forwarder from run-indexer.sh.
# LIVE mode (only with your OWN separate, funded, testnet-only keeper key; NEVER the deployer key):
#   export KEEPER_PRIVATE_KEY=0x...   (exact env name; the key stays in your shell, never in a file)   then   KEEPER_LIVE=yes infra/testnet/run-keeper.sh start
# Live jobs spend gas for no on-chain reward except liquidations: budgets are in keeper.testnet.toml (0.05 USD per job); max_fee_gwei = 2.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
DEP="${DEPLOYMENT:-$ROOT/contracts/deployments/arbitrumSepolia.json}"
BIN="${KEEPER_BIN:-$ROOT/services/keeper/target/release/perp-keeper}"
PIDF="$HERE/keeper.pid"; LOG="$HERE/keeper.log"
running() { [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" -o command= 2>/dev/null | grep -q perp-keeper; }
case "${1:-status}" in
  start)
    running && { echo "already running, pid $(cat "$PIDF")"; exit 0; }
    curl -s -m 3 localhost:18701 >/dev/null || { echo "RPC forwarder not running: run infra/testnet/run-indexer.sh start first"; exit 1; }
    export KEEPER_EXCHANGE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['exchange'])" "$DEP")"
    export KEEPER_START_BLOCK="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['startBlock'])" "$DEP")"
    if [ "${KEEPER_LIVE:-no}" = "yes" ]; then
      [ -n "${KEEPER_PRIVATE_KEY:-}" ] || { echo "KEEPER_LIVE=yes needs KEEPER_PRIVATE_KEY in your shell"; exit 1; }
      export KEEPER_DRY_RUN=false; echo "LIVE MODE: will send transactions from the keeper key (gas budgets in keeper.testnet.toml)"
    else unset KEEPER_PRIVATE_KEY; export KEEPER_DRY_RUN=true; echo "DRY-RUN: simulate only"; fi
    cd "$ROOT"; nohup "$BIN" --config "$HERE/keeper.testnet.toml" > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDF"; sleep 2; echo "pid $(cat "$PIDF"), metrics http://127.0.0.1:9150/metrics, log $LOG";;
  stop) if running; then kill "$(cat "$PIDF")"; echo stopped; else echo "not running"; fi; rm -f "$PIDF";;
  status) if running; then echo "running pid $(cat "$PIDF")"; tail -5 "$LOG" | cut -c1-200; else echo "not running"; fi;;
  *) echo "usage: $0 start|stop|status"; exit 2;;
esac
