#!/bin/sh
# Repeatable overflow/overlap audit of the ticket (+ account card) across sizes, themes and tenants. Needs the dev server on :3147 and the local chain.
# Usage: sh scripts/dev/ticket-audit.sh [desktop|mobile|all]   Exit code 1 if any finding.
cd "$(dirname "$0")/../.." || exit 1
SET=${1:-all}; DESK="1280x720 1375x733 1440x900 1600x900 1920x1080"; MOB="375x812 390x844 360x740 414x896"; BAD=0
case $SET in desktop) SZ=$DESK; CL="Limit";; mobile) SZ=$MOB; CL="Long|Limit";; *) SZ="$DESK $MOB";; esac
for h in localhost nova.localhost; do for t in dark light; do for s in $SZ; do
  w=${s%x*}; if [ "$SET" = all ]; then if [ "$w" -lt 768 ]; then CL="Long|Limit"; else CL="Limit"; fi; fi
  r=$(node scripts/dev/shoot.mjs --eval scripts/dev/mobile-audit.js --noshot --connect --theme $t --host $h --size $s --click "$CL" 2>&1 | tr -d '\n ' | grep -o '"summary":{[^}]*}')
  echo "$h $t $s $r"; case $r in *'"overflow":0,"overlap":0,"small":0,"font":0,"inputmode":0,"docOverflow":false'*) ;; *) BAD=1;; esac
done; done; done
exit $BAD
