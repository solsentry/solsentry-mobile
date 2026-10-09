# KYW `tx.core` vectors (spec_version "0")

Shared contract between the Python server (`integrations/kyw/fact.py`) and every validator client
(Android app, web, Node CLI). A client is correct only when it reproduces `manifest.json` for every file in `raw/`.

- `raw/tx_*.json`: 35 public transactions (20 recent, 15 from 2021–2024 blocks), raw `getTransaction` bodies as
  returned by `api.mainnet-beta.solana.com` on 2026-10-09, read with `manifest.read_params`. Their facts match the
  digests measured the same day across 9 RPC providers.
- `raw/synthetic_*.json`: derived locally. `null` result, RPC error, version refusal, 429, lamports above 2^53
  (`2^53+1` and `2^63-1`), and a float fee (`5000.0`) that must be rejected. Plus three shapes the public endpoint
  never returned in this sample, each one the only cover for a branch of `tx_core`:
  - `synthetic_lookup_unexpanded`: lookup-table keys left in `meta.loadedAddresses` instead of appended to
    `accountKeys`. **Same `fact_digest` as `tx_00`** — a client that skips the expansion fails here, not in production.
  - `synthetic_token_owner_absent`: a token balance without `owner`. Absent reads as `null`, and the digest moves.
  - `synthetic_err_other_wording`: `tx_00` with `meta.err` reworded as another provider words it.
    **Same `fact_digest` as `tx_00`** — this is the whole point of `failed`.
- `manifest.json`: per vector, `raw_sha256` of the file bytes, expected `status`, `unknown_reason`, `fact_digest`, `failed`.

Regenerate: `python ops/tools/kyw_vectors.py --signatures <list> --out tests/fixtures/kyw_tx_core`.
Recompute the manifest only: `--rebuild-manifest`.

## Traps for TypeScript / Hermes clients

1. `JSON.parse` loses integers above 2^53. Parse the raw body with a lossless parser and keep integers as BigInt.
2. Print BigInt as a bare integer in the canonical form, never as a string.
3. A numeric literal with `.` or an exponent in any fact field is a float: the fact is `unknown/invalid_response`.
   `JSON.parse("5000.0")` returns `5000`, so only a lossless parser can see it (vector `synthetic_float_fee`).
4. Sort object keys by code point; no whitespace; UTF-8. Hash with sha256 over the UTF-8 bytes; hex lowercase.
5. Token balances are sorted by the canonical string of each balance object; `innerInstructions` by `index`.
6. `owner` missing → `null`; `blockTime` may be `null`; `preTokenBalances`/`innerInstructions` null or missing → `[]`.
7. `failed` = `meta.err !== null`. The error detail is outside the fact.
8. Run the vectors on the device (Hermes), not only in Node.
9. **Transaction v1 exists on mainnet** (SIMD-0385; 7 of the 20 recent vectors). Its message carries
   `transactionConfig` (`computeUnitLimit`, `heapSize`, `loadedAccountsDataSizeLimit`, `priorityFee`) instead of
   `header`, and `meta` carries `costUnits`. **None of that enters the `tx.core` v0 fact**, and neither does
   `transactionIndex`. Copy `fact.py` field for field; do not add what the response happens to carry.
10. Token balances are sorted by the canonical STRING of each object, so `"accountIndex":10` sorts before
   `"accountIndex":2`. Sorting numerically gives a different digest; 5 vectors catch it (`tx_10` has 11 balances).
