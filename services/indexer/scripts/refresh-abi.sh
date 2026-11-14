#!/usr/bin/env bash
# Refresh the embedded ABI from the contracts package after the contracts gained events/functions.
#   1. copies contracts/abi/PerpExchange.merged.json -> abi/PerpExchange.merged.json (validated JSON, must contain events)
#   2. prints which events were added/removed, so you know what the indexer will newly decode
# Then: cargo build --release   (the ABI is embedded at build time; --abi-file overrides it at runtime without a rebuild)
#       perps-indexer reindex-from-raw   (re-derives events that an older ABI stored as Unknown:<topic0> / Undecodable:*,
#                                         purely from the raw topics+data kept in Postgres - no RPC needed)
# Unknown events never stop ingestion: they are stored raw and counted in indexer_undecoded_events_total.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HERE/../../contracts/abi/PerpExchange.merged.json}"
DST="$HERE/abi/PerpExchange.merged.json"
[ -f "$SRC" ] || { echo "source ABI not found: $SRC" >&2; exit 1; }
jq -e 'type=="array" and ([.[]|select(.type=="event")]|length)>0' "$SRC" >/dev/null || { echo "not a JSON ABI with events: $SRC" >&2; exit 1; }
ev() { jq -r '.[]|select(.type=="event")|.name+"("+([.inputs[].type]|join(","))+")"' "$1" | sort; }
if [ -f "$DST" ]; then
  echo "added events:";   comm -13 <(ev "$DST") <(ev "$SRC") | sed 's/^/  + /'
  echo "removed/changed events:"; comm -23 <(ev "$DST") <(ev "$SRC") | sed 's/^/  - /'
fi
cp "$SRC" "$DST"
echo "ABI updated ($(ev "$DST" | wc -l | tr -d ' ') events). Next:"
echo "  cargo build --release --locked"
echo "  perps-indexer --database-url ... reindex-from-raw      # only if the DB already holds undecoded events"
echo "  (or run the old binary against the new ABI without rebuilding:  --abi-file $SRC)"
