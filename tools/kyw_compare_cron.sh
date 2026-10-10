#!/usr/bin/env bash
# Periodic tx.core comparison on the three RPCs the app offers with a user key (Helius, QuickNode,
# Solami): 35 public vectors each, one JSON per run, for comparison over time. Keys are read at run
# time from an env file (and an optional Solami key file); only labels and hosts are written.
set -euo pipefail
cd "$(dirname "$0")/.."
# Machine paths live in tools/kyw_compare_cron.local.env (not in the repo):
#   KYW_COMPARE_OUT_DIR   where the JSON of each run goes
#   KYW_COMPARE_ENV       env file with the provider keys
#   KYW_COMPARE_SOLAMI_KEY_FILE  optional file whose first key-like line is the Solami key
[ -r tools/kyw_compare_cron.local.env ] && . tools/kyw_compare_cron.local.env
out_dir="${KYW_COMPARE_OUT_DIR:?set KYW_COMPARE_OUT_DIR}"
mkdir -p "$out_dir"
export KYW_COMPARE_ONLY=helius,quicknode,solami
export KYW_COMPARE_ENV="${KYW_COMPARE_ENV:?set KYW_COMPARE_ENV}"
export KYW_COMPARE_OUT="$out_dir/rpc_compare_$(date -u +%Y-%m-%dT%H%MZ).json"
if [ -r "${KYW_COMPARE_SOLAMI_KEY_FILE:-}" ]; then
  KYW_COMPARE_SOLAMI_KEY=$(grep -m1 -E '^[A-Za-z0-9_-]{16,}' "$KYW_COMPARE_SOLAMI_KEY_FILE" | tr -d ' \r\n' || true)
  export KYW_COMPARE_SOLAMI_KEY
fi
echo "# $(date -u +%Y-%m-%dT%H:%MZ)" >> "$out_dir/summary.log"
nice -n 19 timeout 900 npx vitest run --config tools/live/vitest.config.ts kyw-rpc-compare 2>&1 \
  | grep -E 'ok +[0-9]+/' | sed -E 's/(api[-_]key=)[A-Za-z0-9-]+/\1<hidden>/g' >> "$out_dir/summary.log"
