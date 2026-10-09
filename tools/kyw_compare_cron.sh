#!/usr/bin/env bash
# Periodic tx.core comparison on the three RPCs the app offers with a user key (Helius, QuickNode,
# Solami): 35 public vectors each, one JSON per run, for comparison over time. Keys are read at run
# time from the SolSentry .env (and the Solami key file); only labels and hosts are written.
set -euo pipefail
cd "$(dirname "$0")/.."
out_dir=/home/crash/projects/solsentry/internal/docs/audits/2026-10-09_rpc_bench/d8_ts_client/periodic
mkdir -p "$out_dir"
export KYW_COMPARE_ONLY=helius,quicknode,solami
export KYW_COMPARE_ENV=/home/crash/projects/solsentry/.env
export KYW_COMPARE_OUT="$out_dir/rpc_compare_$(date -u +%Y-%m-%dT%H%MZ).json"
if [ -r /mnt/c/Users/Crash/Desktop/sss.txt ]; then
  KYW_COMPARE_SOLAMI_KEY=$(grep -m1 -E '^[A-Za-z0-9_-]{16,}' /mnt/c/Users/Crash/Desktop/sss.txt | tr -d ' \r\n' || true)
  export KYW_COMPARE_SOLAMI_KEY
fi
echo "# $(date -u +%Y-%m-%dT%H:%MZ)" >> "$out_dir/summary.log"
nice -n 19 timeout 900 npx vitest run --config tools/live/vitest.config.ts kyw-rpc-compare 2>&1 \
  | grep -E 'ok +[0-9]+/' | sed -E 's/(api[-_]key=)[A-Za-z0-9-]+/\1<hidden>/g' >> "$out_dir/summary.log"
