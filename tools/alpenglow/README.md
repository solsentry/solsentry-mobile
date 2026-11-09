# Alpenglow finality artifacts and phone verifier

This is a test-build integration. It verifies BLS finality certificates against an
explicit epoch validator table. It does not authenticate transaction contents,
account balances, wallet safety, or epoch transitions.

## Trust boundary

A valid signature against an attacker-supplied table is insufficient: the attacker
can choose all its keys and stakes. Public snapshot downloads and their SHA-256
digests are **provenance and integrity evidence**, not a consensus trust root.
Checking subgroup membership is also not a proof of validator registration or
proof-of-possession admission on the real chain.

`EpochTable` therefore reports `untrusted-table` unless the caller supplies an
epoch-specific table digest from its own configuration. The artifact server cannot
promote its own table to trusted. A matching local pin produces `verified` **under
the operator-pinned table assumption**, not an independently authenticated chain.
All user-facing success text states that assumption.

For a deployed service, obtain the checkpoint from an operator-controlled validator
whose bank has been replayed/validated, provision it through an authenticated
operator release/configuration channel, and review its epoch and network. Comparing
tables from independent operators is useful corroboration, but cannot replace the
initial checkpoint. Never bootstrap the pin from the same relay response.
The certificate alone cannot authenticate the following epoch's stake table.

No production checkpoint is configured by this change. The phone screen defaults
to the untrusted result. Configuring trust and deploying the collector remain
operator actions after reviewing the source of the checkpoint.

## Protocol checked

- Agave v4.4.0 [vote payload tags and encoding](https://github.com/anza-xyz/agave/blob/v4.4.0/votor-messages/src/wire.rs).
- [Certificate thresholds and source votes](https://github.com/anza-xyz/agave/blob/v4.4.0/votor-messages/src/certificate.rs):
  fast finality >=80%; slow finality requires Finalize(slot) >=60% and
  Notarize(slot, block root) >=60%. Comparisons use integer cross-products.
- [BLS certificate verification](https://github.com/anza-xyz/agave/blob/v4.4.0/bls-cert-verify/src/cert_verify.rs):
  mixed Base3 votes are permitted for notarize-fallback and skip, not fast finality.
- [Rank construction](https://github.com/anza-xyz/agave/blob/v4.4.0/runtime/src/epoch_stakes.rs):
  positive stake, registered BLS key, exclude **all** copies of duplicated BLS/node
  identities, then stake descending and compressed-key bytes ascending.
- [Yellowstone footer schema](https://github.com/rpcpool/yellowstone-grpc/blob/b408d1fa01458b90818fc4ba99831a6b254cbf26/yellowstone-grpc-proto/proto/geyser.proto):
  `block_id` is the last data shred's Merkle root, **not** the PoH blockhash.

The signed slot is `final_cert.slot`; the enclosing footer may be slot+1. Bind the
request to the former. Unknown signature kinds/bitmap versions, wrong epochs,
insufficient stake, malformed points, identity keys, malformed tables, duplicate
keys and incorrect pins fail closed. A valid standalone skip or reward certificate
does not qualify as a block finality certificate.

The snapshot parser recognizes the observed v4.4 layout using bounded candidate
search and strict owner/version/size/epoch/total/uniqueness checks. It rejects absent
or ambiguous candidates. It is not a general snapshot parser or validator replay.
The packer additionally rejects invalid BLS keys instead of silently excluding them.

## Artifact contract

One archive directory per cluster, shred version and epoch schedule. `network.json`
prevents accidentally mixing these. No credentials are included in artifacts.

```
network.json
epochs/<epoch>/table.bin
epochs/<epoch>/provenance/<report-sha256>.json
certificates/<certificate-slot>.json
certificate-variants/<certificate-slot>/<certificate-sha256>.json
capture-reports/<timestamp>.json
source-tables/<bank-sha256>-<epoch>.json
banks/<bank-sha256>.bin        # when downloaded by snapshot.py
```

`table.bin` is a 32-byte header followed by 56 bytes per rank:

| Offset  | Encoding          | Meaning                                        |
| ------- | ----------------- | ---------------------------------------------- |
| 0       | 4 ASCII bytes     | `SSET`                                         |
| 4       | u8                | Version 1                                      |
| 5       | u8                | 0 mainnet-beta, 1 devnet                       |
| 6       | u16 LE            | Shred version                                  |
| 8       | u64 LE            | Epoch                                          |
| 16      | u64 LE            | First slot of that epoch                       |
| 24      | u32 LE            | Slots per epoch                                |
| 28      | u16 LE            | Validator count, 1..2000                       |
| 30      | u16 LE            | Reserved, zero                                 |
| 32+56*i | 48 bytes + u64 LE | Compressed G1 public key and stake in lamports |

SHA-256 covers the entire header and rows. Total stake is the sum of the ranked
table, checked for u64 overflow. Network and schedule policy are caller-owned,
including first-normal-slot metadata; warmup certificates are unsupported.
Mainnet deployment defaults here are shred version 50093 and 432000 slots/epoch;
these are configuration values, not remote claims accepted from a table.

Certificate JSON is `{slot, final: {kind:0,sig,block_id,bitmap}, notar: null|aggregate}`.
Binary fields are canonical base64. Slot is a safe JSON integer. No outer footer
bank hash is treated as a signed block root. Conflicting observations are retained
as separate immutable variants; the first observation is served, never asserted
verified by the archive writer. The phone verifies every served certificate.

Files publish atomically without replacement. Repeating an identical import is
idempotent. Changed table bytes for an existing epoch cause an error; no silent
overwrite or automatic trust refresh occurs. Preserve the conflicting sources
outside that archive for investigation.

## Run the tools

Use a dedicated Python environment with `requirements.txt`. The existing research
environment can run these tools without installing anything else. Generate Python
gRPC bindings from the official pinned Yellowstone schemas before capture; see
`prepare_proto.py`. Credentials must already be supplied through environment.

```bash
python tools/alpenglow/prepare_proto.py --output dist/alpenglow-proto

python tools/alpenglow/snapshot.py \
  --bank BANK.bin --output dist/alpenglow-archive \
  --epochs 1080 1081 1082 --cluster mainnet-beta --shred-version 50093

python tools/alpenglow/capture.py \
  --proto-dir dist/alpenglow-proto --output dist/alpenglow-archive \
  --cluster mainnet-beta --shred-version 50093 \
  --max-certificates 40 --timeout 120 --not-after 2026-11-11T00:00:00Z
```

`snapshot.py --url PUBLIC_SNAPSHOT_URL` fetches only the bank prefix of a full
`.tar.zst` archive, follows a public snapshot redirect, and retains the bank by
hash. Limits: 256 MiB compressed, 512 MiB expanded TAR prefix, 256 MiB bank, ten
prefix entries and a 120-second deadline (socket reads also time out). No TAR path
is extracted. A stalled socket can take up to 20 seconds beyond the logical
deadline to return its timeout.

`capture.py --snapshot-url PUBLIC_SNAPSHOT_URL` also tries to preserve each observed
epoch and the successor. Missing observed or next-epoch tables produce an explicit nonzero result, even
without `--snapshot-url`, with certificates retained for later retry. Reports list
`tables_present`, `missing_epochs` and sanitized `table_errors`; presence indicates
retained bytes, not authentication. Snapshot download failures also retain a report. A stale snapshot can lack the next epoch;
do not infer availability from the RPC node's version. `--from-slot` requests
bounded provider replay when supported. Replay retention is not assumed.

The cutoff is mandatory and checked before opening gRPC; the connection deadline
cannot extend beyond it. The conservative example cutoff precedes the stated trial
end. Changing it does not confirm billing terms or enable a paid add-on. No scheduler
or persistent process is installed. A deployment scheduler should run bounded
captures repeatedly, alert on failures/missing epochs, enforce its credit budget,
and stop at the approved cutoff. This tool does not deploy a server.

HTTP artifact serving is read-only. A relay can expose the two phone paths above,
using HTTPS, without exposing source tables, banks, reports or provider credentials.
The native reader aborts oversized responses through XHR progress events; it also
checks headers, body size, redirects, HTTP status and caller cancellation. The
client limits requests to 30 seconds by default and caches at most two prepared
tables. Table preparation yields between four-key batches and supports cancellation.
Caller cancellation propagates through the client and table preparation, even if
a transport ignores abort. The screen offers cancellation and aborts on unmount.
Single signature checks still run synchronously; no new phone timings are claimed.

## Phone screen

Only a self-test build can open `solsentry://certificates`. The normal Metro
resolver removes the diagnostic screen and its verifier dependency from the route.
The route redirects home in normal builds. This change does not enable a public
wallet badge or change points/claims.

For local testing, serve the archive root on port 8093 and reverse that port to the
phone. The screen accepts the artifact base URL, target certificate slot and an
optional operator table digest. HTTP is permitted only for localhost in this screen.
Do not enter a provider RPC URL or token. The digest is manually entered rather
than fetched from the artifact server. Results log with `ALPENGLOW_SELFTEST`.

## Validation

```bash
npx vitest run
npx tsc --noEmit
python -m unittest discover -s tools/alpenglow -p 'test_*.py' -v
npx vitest run --config tools/live/vitest.config.ts tools/live/alpenglow-artifacts.test.ts
```

Fixtures cover 88 distinct aggregate signatures (92 footers) from mainnet
(epochs 1080–1082: 12, 38 and 38 distinct signatures) and 40 devnet
observations (1204, including four slow-path certificates). Synthetic signatures
are generated independently by py_ecc 8, including exact 60/80% thresholds,
mixed-message Base3 and fallback-only signers. Tests also cover integer precision,
altered signatures/roots/slots, corrupt tables/bitmaps, low stake, network failures,
cancellation, epoch-boundary caching and release-screen exclusion.

No APK, store release, production collector, authenticated epoch checkpoint or
server deployment is included. Battery, native XHR behavior and the new async
preparation path still require a new authorized phone build/test.

See [OPERATIONS.md](OPERATIONS.md) for the operator handoff and device test matrix.
