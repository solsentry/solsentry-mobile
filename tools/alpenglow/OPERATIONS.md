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

The original retained public bank covers epochs 1078–1082 and cannot produce epoch
1083. A later public bank at slot 467482256 supplied the epoch-1083 table on
2026-11-09 and reproduced the epoch-1082 table byte-for-byte. No epoch-1083
certificate was available during that acquisition. Both banks remain untrusted.
Current/future public snapshot availability is not an authenticated table service.
Do not reconstruct a substitute from current vote balances or rounded stake data:
those candidate reconstructions failed the retained mainnet signatures.

## Repeatable next-epoch routine

1. Read finalized `getEpochInfo` from a public RPC and verify the cluster/schedule
   against operator configuration. Let its current epoch be E. Check retained table
   coverage for E and E+1 before opening any certificate stream. Do not request E+2
   merely because an E+1 table has been retained; advance the requirement when the
   observed certificate epoch advances.
2. After an epoch starts, obtain a full snapshot with a bank slot at or after that
   epoch's first slot. Resolve the public RPC's `/snapshot.tar.bz2` alias with a bounded
   HEAD request before downloading. The filename provides a freshness filter only;
   the parser must still find exactly one valid layout for each requested epoch.
   If known aliases remain old, discover advertised public RPCs via `getClusterNodes`,
   use only globally routable addresses, bound concurrency/timeouts, and retain probe
   results. Successful HEAD/modern node version alone does not prove table availability.
3. Fetch only the bank prefix using `snapshot.py`, not the full advertised archive.
   Extract E and E+1. If E already exists, require identical table bytes; archive
   conflict is a hard failure, not a reason to replace the old table or its pin.
   Keep source bank digest/slot, parser revision, source-table digest and manifests.
   Keep the resulting next-epoch table even if its certificates do not yet exist.
4. Repeat only when coverage is missing, a source changes, or a conflicting result
   needs investigation. Operational monitoring should check on epoch change and
   periodically before the boundary (for example every 30 minutes); this document
   does not install a scheduler. Alert if freshness/acquisition fails or the next
   table is still absent before the boundary; use another advertised source without
   silently extending caps or provider access. A previously successful IP is not a
   permanently maintained source.
5. A public bank remains untrusted. Matching E against retained verified-signature
   inputs is useful corroboration but cannot authenticate E+1. For production pins,
   repeat the export on an operator's validated/replayed bank, review the network,
   epoch and canonical SSET digest, then deliver the digest through authenticated
   operator release/configuration. Never take the pin from the relay or promote a
   public fixture digest to production trust. A conflicting source or changed pin
   requires review; keep historical bytes immutable.
6. Re-read the live epoch/slot and time before a transition capture. A rate-based
   boundary estimate changes with the network and is not a scheduled wakeup. If the
   next epoch has not started, spend the stream window only close enough to observe
   the boundary within the authorized total duration. Stop at the explicit UTC cutoff
   even if the epoch has not advanced. Keep a ledger of stream durations across runs;
   a per-run timeout is not an aggregate budget. If the available window cannot cover
   the boundary, report the real certificate test as pending.
7. After observing E+1, preserve every certificate variant and run the archive/client
   integration with both tables. Require actual certificate slots on each side of the
   boundary. Then check coverage for E+1 and E+2; acquiring E+1 does not establish E+2.
   Table parsing, synthetic tests and rejection of an old relabelled signature do not
   substitute for a real new-epoch signature verification.

Example extraction (operator-supplied public source and observed epoch numbers):

```bash
timeout 150s nice -n 19 ionice -c3 dist/b4_epoch/venv/bin/python tools/alpenglow/snapshot.py \
  --url "$PUBLIC_SNAPSHOT_URL" --output dist/alpenglow-archive \
  --epochs 1082 1083 --cluster mainnet-beta --shred-version 50093
```

Keep a protected record of the configured source; never put a provider token into a
snapshot URL. Acquisition uses public HTTP/RPC, with no paid service enabled by the
tool. Bandwidth and host resources still matter: the 2026-11-09 successful new-bank
extraction read **74,712,750 compressed bytes** and retained **169,132,871 bank bytes**;
it did not download the advertised roughly 126 GB full archive. These are measured
sample sizes, not a fixed per-epoch forecast. Hard limits remain 256 MiB compressed,
512 MiB expanded TAR prefix, 256 MiB bank and a 120-second logical deadline (a socket
timeout can return up to 20 seconds later). A second corroboration source consumes
another bounded prefix download. Keep actual download counts and sizes in the report.
Certificate traffic and trial access are separate from public snapshot bandwidth.

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

The last command uses the retained local archive, opens no provider connection,
verifies all variants against their epoch tables, and prepares the following epoch's
table. Table preparation alone does not verify a future certificate. It intentionally expects an
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
