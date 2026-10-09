# SolSentry KYW (Android)

Verify public Solana transactions on your phone.

The app asks the SolSentry server for a task (the signature of one public transaction), reads that
transaction from a Solana RPC, recomputes a small set of facts from it on the phone, and sends back
a sha256 digest of those facts. The server compares the digest with its own reference read and
answers `accepted`, `diverged` or `unknown`. An accepted result reads "Matched SolSentry's
reference read." It says nothing about any wallet, token or person. Nothing is paid or earned in
this version.

Package id `app.solsentry.kyw`. Expo / React Native, Android only. It is a sibling of SolSentry
Guard (`app.solsentry.guard`) and installs next to it.

## What it does

- **One screen.** A switch turns validation on and off. A grid shows one square per task
  (matched, diverged, no result), with counters. Tapping a square shows that task: part of the
  signature, the result, the time the read took, the size of the response and the RPC host.
- **RPC choice.** `SolSentry (default)` reads through the SolSentry server, which only reads the
  open task. `Helius`, `QuickNode` and `Solami` (beta) use a key or endpoint URL you paste. The key
  is sent only to that provider. SolSentry receives the provider host name, never the key. With
  "Save my key" on, the key is stored with `expo-secure-store` (Android Keystore); with it off, the
  key lives in memory until the app closes.
- **Background.** A foreground service with a fixed notification keeps validation running with
  the app in the background and with the screen off. Settings: battery optimization exemption,
  only on Wi-Fi, only while charging, pause between tasks.
- **Kept on the phone.** The last 364 tasks and the counters (AsyncStorage). Only part of each
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

Build (release variant, signed with the keystore named in `~/.keys/solsentry-kyw/keystore.properties`
or in `KEYSTORE_PROPERTIES`; the keystore is never in the repo):

```bash
npx expo prebuild -p android --clean
cd android && ./gradlew assembleRelease
```

Self-test build: set `EXPO_PUBLIC_KYW_SELFTEST=1`
for both commands. It adds a screen that runs the 48 vectors on the device and lets the app talk to
a server on the PC (`adb reverse tcp:8092 tcp:8092`). A normal build contains neither the screen nor the vectors.

## Guard code

The screens of SolSentry Guard (Check & Send, Approvals, History, QR scanner) are kept in
`src/guard-screens/` and are not reachable in this app. Their README is
`src/guard-screens/GUARD_README.md`.
