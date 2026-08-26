#!/bin/bash
cd /Users/chloeongsiyi/Trenchcoons
for i in 1 2 3 4; do
  out=$(node tools/shots.mjs "$@" 2>&1)
  if echo "$out" | grep -q "shot(s) ok"; then echo "$out" | tail -1; exit 0; fi
  bad=$(echo "$out" | grep "^  FAIL" | awk '{print $2}' | tr '\n' ' ')
  echo "retry $i for: $bad"
  set -- $bad
  sleep 3
done
echo "STILL FAILING: $*"; exit 1
