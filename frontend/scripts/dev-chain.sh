#!/usr/bin/env bash
# Boots an isolated hardhat node (default :18647), deploys the contracts into frontend/.fe/deployments/fe.json and syncs the
# frontend. Never touches contracts/deployments/localhost.json. Usage: scripts/dev-chain.sh [port]
set -euo pipefail
PORT="${1:-18647}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS="$(cd "$HERE/../contracts" && pwd)"
HH="$CONTRACTS/node_modules/.bin/hardhat"
export FE_RPC="http://127.0.0.1:$PORT" CONTRACTS_DIR="$CONTRACTS"
mkdir -p "$HERE/.fe"
cd "$CONTRACTS"
nohup "$HH" --config "$HERE/scripts/hardhat.fe.config.js" node --hostname 127.0.0.1 --port "$PORT" > "$HERE/.fe/node.log" 2>&1 < /dev/null &
echo $! > "$HERE/.fe/node.pid"
for _ in $(seq 1 100); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$FE_RPC" >/dev/null 2>&1 && break; sleep 0.3; done
rm -rf "$HERE/.fe/deployments"
(cd "$HERE/.fe" && "$HH" --config "$HERE/scripts/hardhat.fe.config.js" run "$CONTRACTS/scripts/deploy.js" --network fe > "$HERE/.fe/deploy.log" 2>&1) || { cat "$HERE/.fe/deploy.log"; exit 1; }
node "$HERE/scripts/sync-deployment.mjs" --file "$HERE/.fe/deployments/fe.json"
echo "node pid $(cat "$HERE/.fe/node.pid") on $FE_RPC"
