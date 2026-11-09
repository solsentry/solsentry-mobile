# Alpenglow operator handoff

## Current delivery and gates

The draft implementation is a test-build verifier and a bounded archival collector.
A successful local signature check proves correspondence to supplied epoch-table bytes.
It does not authenticate those bytes, validate wallet contents or establish trust in a
successor epoch. Keep normal app builds outside the diagnostic route.

Before production, the operator must provide:

1. An exact SSET table exported from a replayed/validated bank, with cluster, shred
   version, schedule, epoch, bank slot/hash, software revision and extraction provenance.
2. A table digest provisioned through an authenticated operator release/configuration
   channel. The artifact relay cannot set its own trust pins. A public snapshot hash or
   agreement between public servers is corroboration, not the initial trust root.
3. A repeatable export for the next epoch before the current epoch ends, with explicit
   coverage monitoring. Retain historical tables and certificate variants unchanged.
4. An owner-authorized server deployment and an owner-authorized phone build/test.

QuickNode supplied certificate observations during the approved trial. Its supplied
reply says its supported Agave release has no VAT rank-map method or epoch-stakes export
for these samples. The Agave v4.4.0 RPC source has no `getVatActiveSetRankMap`; the method
exists in the newer upstream source. Availability on a provider must be measured.
Sources checked 2026-11-09:

- https://github.com/anza-xyz/agave/blob/v4.4.0/rpc/src/rpc.rs
- https://github.com/anza-xyz/agave/blob/master/rpc/src/rpc.rs

The retained public bank covers epochs 1078–1082. It cannot produce epoch 1083.
Current/future public snapshot availability is not an authenticated table service.
Do not reconstruct a substitute from current vote balances or rounded stake data:
those candidate reconstructions failed the retained mainnet signatures.

## Server contract and capture monitoring

Serve only `certificates/<slot>.json` and `epochs/<epoch>/table.bin` over HTTPS.
Keep banks, provenance, source tables, reports and all provider credentials private.
Configure cluster, shred version and epoch schedule independently of remote artifacts.
Use the existing collector command in README with an approved explicit UTC cutoff.
No persistent scheduler or production endpoint is installed by this change.

Every scheduled run must inspect both exit status and its capture report:

| Condition | Action |
| --- | --- |
| Nonzero exit or no final report | Alert; preserve stderr and existing artifacts; avoid blind unlimited retries |
| `observations == 0` | Alert for stream silence/outage |
| `status != ok` | Alert with sanitized status; do not interpret partial capture as complete |
| `missing_epochs` nonempty | Alert for observed/next epoch gaps; acquire exact table before use |
| `table_errors` nonempty | Investigate snapshot/export failure; do not promote existing bytes to trusted |
| Expected run/report is stale | Alert for collector/scheduler failure |
| Access cutoff reached | Stop provider access; do not extend without an explicit approved cutoff |

`tables_present` means files exist, not that signatures or the table source were
validated. A post-capture offline verification must inspect every immutable variant,
not just the first aggregate served for a slot. Reports never contain provider tokens
or exception messages that could echo a credentialed URL. Preserve a failed capture's
certificates for later table acquisition. Resolve conflicting table bytes separately;
never overwrite the existing epoch or silently change a pin.

The original short-sample GB/hour estimates used decoded protobuf bytes. They are not
compressed network traffic, provider billing measurements or monthly cost forecasts.

## Offline verification before a phone build

Run from the repository root, one bounded low-priority job at a time:

```bash
timeout 120s nice -n 19 ionice -c3 npx vitest run
timeout 120s nice -n 19 ionice -c3 npx tsc --noEmit
timeout 60s nice -n 19 ionice -c3 dist/b4_epoch/venv/bin/python -m unittest discover -s tools/alpenglow -p 'test_*.py' -v
timeout 150s nice -n 19 ionice -c3 npx vitest run --config tools/live/vitest.config.ts tools/live/alpenglow-artifacts.test.ts
```

The last command uses the retained local archive, opens no provider connection, and
verifies all variants against their epoch tables. It intentionally expects an
`untrusted-table` result with valid signatures when no operator pin is provisioned.

## Seeker validation after the specific build order

Use the existing `tools/build_apk.sh selftest` variant after authorization. Record
source commit, APK SHA-256, device serial, Android version and JS engine. Use Windows
ADB only, at `/mnt/c/Users/Crash/AppData/Local/Android/Sdk/platform-tools/adb.exe`.
Serve the local archive without provider access, then reverse the local port:

```bash
python3 -m http.server 8093 --bind 127.0.0.1 --directory dist/alpenglow-archive
/mnt/c/Users/Crash/AppData/Local/Android/Sdk/platform-tools/adb.exe -s SM02G40619144343 reverse tcp:8093 tcp:8093
/mnt/c/Users/Crash/AppData/Local/Android/Sdk/platform-tools/adb.exe -s SM02G40619144343 shell am start -a android.intent.action.VIEW -d solsentry://certificates app.solsentry.mobile
```

The HTTP server is temporary and serves only the local test setup; stop it and remove
the reverse port when done. Do not deploy this whole-directory development server.

| Device case | Required observation |
| --- | --- |
| First mainnet check without a pin | Valid signature, `untrusted-table`, source warning visible; record cold milliseconds |
| Repeat same slot/epoch | Same result, no table re-download; record warm milliseconds |
| Epoch 1081 then 1082 | Correct table requested for each; retain epoch/slot in logs |
| Locally entered matching test digest | `verified`, with explicit operator-pinned assumption; this is a test pin only |
| Wrong digest, slot, root or altered signature | No successful result |
| Missing epoch or HTTP 404 | `unavailable`; no stale-table substitution |
| Oversized/truncated response and network stall | Bounded failure; record native progress/abort behavior |
| Cancel during download/table preparation | Request aborts; UI becomes usable |
| Leave screen during check, reopen | No old request updates the new screen; no lingering download |
| Normal release build | Diagnostic screen and verifier dependencies excluded; route redirects home |

The current manual screen is mainnet-only. Slow finality has devnet and synthetic
unit coverage; a devnet device run needs explicit devnet configuration, not a mainnet
shred-version override. Do not claim slow-path phone coverage from a mainnet run.

Record `ALPENGLOW_SELFTEST` logs, native response size, cold/warm timing and a repeated
run's responsiveness. Battery evaluation needs a separately defined duration and
baseline; do not infer it from a single check. Stop local servers and device logging
when finished. Any test-device uninstall may lose points, device key or wallet link;
report actual losses. Never modify signing keys.
