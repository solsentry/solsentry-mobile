# SolSentry (Android)

> **Clock In submission.** This branch is the build we submitted: release
> [`clockin-2026-10-12`](https://github.com/solsentry/solsentry-mobile/releases/tag/clockin-2026-10-12)
> (APK 0.1.22, commit `3540b80`). It is unchanged; this note is the only commit after the tag.
>
> **Work after the deadline** lives on [`feat/kyw-v0`](https://github.com/solsentry/solsentry-mobile/tree/feat/kyw-v0)
> ([changelog](https://github.com/solsentry/solsentry-mobile/blob/feat/kyw-v0/CHANGELOG.md)). It is not part of
> the submission.
>
> Exploratory branches from an earlier prototype (Guard) were moved to a private archive on Oct 23, 2026 to
> keep this repo focused. The submitted build is unchanged.

Verify public Solana transactions on your phone.

Package id `app.solsentry.mobile`. The public name, slug, scheme and package id are set in `brand.json` only.
Expo / React Native, Android only. Built for the Solana Seeker; runs on any Android phone.

## How verification works

1. **Task.** The phone asks SolSentry for a task: the signature of one public Solana transaction.
2. **Read and recompute.** The phone reads that transaction from a Solana RPC (SolSentry's, or your own URL),
   recomputes a small set of facts from it (`tx.core`, below) and hashes them into a `fact_digest`.
3. **Sign and compare.** The phone signs the result with a key that lives in its hardware keystore and sends it.
   SolSentry compares the digest with its own reference read and answers `accepted`, `diverged` or `unknown`.

An accepted result reads "Matched SolSentry's reference read." It is data verification, not Solana consensus,
and it says nothing about any wallet, token or person. The server half (task issue, reference read,
comparison, Android key attestation, points and the SKR claim) lives in
[`solsentry-mobile-core`](https://github.com/solsentry/solsentry-mobile-core).

## What it does

- **Home.** The app bar shows the linked wallet (avatar drawn from the address, its `.skr` name when it has
  one) with Verified, Genesis and RPC badges. Below: the last 28 days as a grid, the verification switch and
  the points (or SKR) figure with today's cap, and the last tasks as dots (matched, diverged, no result).
- **Points.** Each matched, signed result counts 1 point; bonuses add up: attested device +0.2, linked wallet
  holding a Seeker Genesis Token +0.3, your own tested RPC +0.1. SolSentry computes the balance from the signed
  results and caps it per day; past the cap the phone slows down (or spreads tasks over the day, in Settings).
  Points have no cash value and are not a token. In this test phase of the Seeker launch, Seeker Genesis
  wallets also get SKR from a pool SolSentry funds, claimed to the wallet with one transaction (Claim).
  Caps, rates and the Genesis-only rule belong to the test phase and will change.
- **Wallet.** Linking a wallet is one signed message through Mobile Wallet Adapter, no transaction.
- **RPC.** `SolSentry (default)` reads through the SolSentry server, which only reads the open task. `Your RPC`
  takes any HTTPS mainnet URL; "Test this RPC" measures what it serves. The URL is sent only to that RPC;
  SolSentry receives its host name, never the URL.
- **Background.** A foreground service keeps verification running with the screen off; only on Wi-Fi, only
  while charging and the pause between tasks are in Settings. Verification left on turns on again when the
  app opens after an update or a reboot.
- **Updates.** Outside a store, the app reads `https://solsentry.app/app/latest.json` and offers a newer build
  as a link that opens in the browser. Each build carries its own `versionCode` (`app.json`).
- **Kept on the phone.** The last 364 tasks, the last 28 days, the counters (AsyncStorage). Only part of each
  signature is stored.

## The fact (`tx.core`, spec version 0)

`src/kyw-core/` is plain TypeScript with no React Native import, so the same code can run in a web
page or a Node CLI. It mirrors the Python reference of the SolSentry server:

1. Parse the RPC body without losing anything (`lossless.ts`): integers above 2^53 stay exact and
   `5000.0` is seen as a float. `JSON.parse` cannot do either.
2. Build the fact (`fact.ts`): slot, block time, failed or not, fee, SOL balances before and after,
   token balances before and after, account keys, program of each instruction and inner instruction.
3. Canonical form (`canonical.ts`): keys sorted by code point, no whitespace, integers as bare
   integers, UTF-8. A float anywhere in the fact makes the result `unknown/invalid_response`.
4. `fact_digest` = sha256 of those bytes, lowercase hex.

A result is `ok` or `unknown` with a reason (`not_available`, `rpc_error`, `rate_limited`,
`version`, `timeout`, `invalid_response`). Unknown is a result, never an empty fact.

`tests/fixtures/kyw_tx_core/` holds the 48 vectors shared with the server (35 public transactions
and 13 synthetic cases). The client is correct only when it reproduces the manifest for every one.
`tests/fixtures/kyw_edge_cases.json` adds hand-made bodies with the answer of the Python reference
(`tools/kyw_edge_cases.py` regenerates it).

## Develop

```bash
npm ci
npm run ci                     # typecheck + tests
node tools/kyw_mock_server.mjs # stand-in server on :8091 that serves the public vectors as tasks
```

Build and run on a phone or emulator (needs JDK 17+ and the Android SDK; no signing key required):

```bash
npx expo prebuild -p android --clean
(cd android && ./gradlew assembleDebug)   # android/app/build/outputs/apk/debug/app-debug.apk
npx expo start --dev-client               # the debug build loads the JavaScript from this server
```

Release build (signed with the keystore named in `~/.keys/solsentry-kyw/keystore.properties` or in
`KEYSTORE_PROPERTIES`; the keystore is never in the repo, and without it only release tasks fail):

```bash
tools/build_apk.sh release dist/solsentry.apk
```

Self-test build: set `EXPO_PUBLIC_KYW_SELFTEST=1`
for both commands. It adds a screen that runs the 48 vectors on the device and lets the app talk to
a server on the PC (`adb reverse tcp:8092 tcp:8092`). A normal build contains neither the screen nor the vectors.
