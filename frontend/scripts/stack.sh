#!/usr/bin/env bash
# (Re)start the isolated dev stack: hardhat node :18647 + deploy + Postgres DB perps_fe + Rust indexer :18648 (+ optional seed).
# Usage: scripts/stack.sh [--no-indexer] [--seed]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
pkill -f "hardhat.fe.config.js" 2>/dev/null || true
pkill -f "perps-indexer.*18648" 2>/dev/null || true
sleep 1
scripts/dev-chain.sh 18647
if [[ " $* " != *" --no-indexer "* ]]; then
  dropdb --if-exists perps_fe >/dev/null 2>&1 || true
  createdb perps_fe
  BIN="$HERE/.fe/cargo/release/perps-indexer"
  [ -x "$BIN" ] || (cd "$HERE/../services/indexer" && CARGO_TARGET_DIR="$HERE/.fe/cargo" cargo build --release)
  nohup "$BIN" --rpc-url http://127.0.0.1:18647 --database-url "host=localhost user=$USER dbname=perps_fe" --deployment "$HERE/.fe/deployments/fe.json" \
    --listen 127.0.0.1:18648 --poll-ms 300 --rate-rps 0 > "$HERE/.fe/indexer.log" 2>&1 < /dev/null &
  for _ in $(seq 1 50); do curl -sf localhost:18648/readyz >/dev/null 2>&1 && break; sleep 0.2; done
fi
if [[ " $* " == *" --seed "* ]]; then node scripts/seed.mjs; fi
