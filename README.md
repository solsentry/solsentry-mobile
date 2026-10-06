# SolSentry Guard (mobile)

> Know who gets paid before the money moves.

An Android app that checks **who receives** a payment, and **where your own money came from**, before your wallet is asked to sign. It is the mobile version of the pre-sign checks in [`@solsentry/guard`](https://github.com/solsentry/solsentry-guard), which ran on Solana mainnet on 2026-10-03.

Package id `app.solsentry.guard`. Built with Expo / React Native and Solana Mobile's Mobile Wallet Adapter (MWA).

## What it does

- **Check & Send.** Paste a recipient address and an amount in SOL. "Check recipient" asks the SolSentry API about the address and shows a verdict card with the decision in words (Allow, Warning, Block), the explanation from the guard, and a timestamp.
  - **Allow**: "Send with wallet" is enabled.
  - **Warning**: the send button stays disabled until you switch on "I reviewed this recipient".
  - **Block**: sending is disabled. The app shows "Stopped: nothing was built or signed."
- **What the recipient check looks at.**
  - Catalogued drainers and the recipient's deployer profile in SolSentry's records (HIGH or CRITICAL blocks, MEDIUM warns).
  - Whether the address is a wallet at all: a token mint or a program is blocked, because SOL sent there is lost or never reaches a person.
  - Address poisoning: the recipient is compared with your contacts (addresses you checked that came back Allow, plus the recipients of your wallet's recent SOL transfers). An address that copies both the first and the last characters of a contact is blocked, and the card shows both addresses; one that shares only its start or only its end gets a Warning (vanity addresses do this legitimately). If the wallet's recent transfers cannot be read, the card says the comparison used local history only.
- **Scan to pay (Solana Pay).** "Scan QR" reads a Solana Pay transfer request (`solana:<recipient>?amount=…&label=…&message=…&memo=…&reference=…`) or a plain address QR, fills the form, shows the label and message, and runs the recipient check right away. The amount still goes through the same SOL parser, and the verdict is bound to that address and must be fresh. `reference` keys and the `memo` are added to the transfer as the spec requires. SPL token requests are checked but not sent ("SPL token payments not supported yet"); transaction requests (`solana:https://…`) are refused.
- **Names.** The recipient field accepts `name.skr` (Seeker ID, AllDomains: one PDA derivation and one `getAccountInfo` on mainnet) and `name.sns` / `name.sol` (SNS REST proxy `sdk-proxy-v2.sns.id`, `/safe-resolve`). The resolved address is shown in full and is what gets checked and paid; the name is resolved again when you tap Send (before the wallet opens) and the send is refused if it changed. A name that cannot be resolved is a Block with the reason. Note: SNS stopped resolving `.sol` at slot 452,825,395 (registry migration), so `.sol` currently comes back as Block until SNS re-enables it.
- **Where did my money come from?** After you connect a wallet, the app looks up the wallet's first funder (one hop back, via Solana RPC), screens both the wallet and that funder, and shows the verdict.
- **History.** Addresses you checked, kept on the device (AsyncStorage), each with its verdict, date and a "Re-check" button. Re-check before you pay the same address again: signals change.

## How it works

1. **Check before sign.** The recipient check runs before any transaction exists. A transaction is built only after an Allow (or a reviewed Warning), and the verdict must be for the exact address in the field and less than 5 minutes old.
2. **Fail closed.** If a check cannot run (API down, timeout, bad response, RPC error), the verdict is Block and the reason is shown. The vendored guard defaults to `onCheckError: "block"`; any unrecognised decision is also mapped to Block.
3. **MWA signs.** The app calls `authorize` and `signAndSendTransactions` through `@solana-mobile/mobile-wallet-adapter-protocol-web3js`, building one `SystemProgram.transfer` from the authorized account. There is no key handling, seed, or custody in this app: your wallet app signs.

Config lives in `src/config.ts`: `CLUSTER` (default `mainnet-beta`), `RPC_URL` (`https://api.mainnet-beta.solana.com`) and `API_BASE` (`https://api.solsentry.app`).

## Device check (optional, off by default)

Behind `DEVICE_CHECK_ENABLED` in `src/config.ts` (default `false`). With the flag off the
section does not render and the native module is never called. It is informational only:
it never changes a recipient/sender verdict or the send button.

The local Expo module `modules/device-attestation` (Kotlin, autolinked, Android only) creates a
throwaway EC P-256 key in the Android Keystore with a 32-byte challenge (StrongBox first, then
TEE), asks for brand/model attestation on Android 12+ (the device may refuse), reads the
certificate chain, and deletes the key. It reads no serial number, IMEI or other identifier and
adds no Android permission. The chain goes to the SolSentry server, which checks it against
Google's hardware attestation roots.

The screen separates what the phone **claims** (`Build.MANUFACTURER`/`Build.MODEL`, self-reported)
from what the hardware **proves** (key security level, boot state, attested brand/model if the
device included it, chain validity per the server). Without an attested model it says
"genuine Android device with a hardware-backed key", never a model name.

### API contract

`POST https://api.solsentry.app/v1/device-attestation/verify`

Request:

```json
{
  "challenge": "<base64 of 32 bytes>",
  "chain": ["<base64 DER leaf>", "<base64 DER intermediate>", "..."]
}
```

Response (200):

```json
{
  "valid": true,
  "reason": "revocation_unchecked",
  "security_level": "strongbox | trusted_environment | software",
  "keymaster_security_level": "strongbox | trusted_environment | software",
  "attestation_version": 300,
  "challenge_match": true,
  "root_of_trust": { "verified_boot_state": "verified | self_signed | unverified | failed", "device_locked": true },
  "attested_ids": { "brand": "...", "device": "...", "product": "...", "manufacturer": "...", "model": "..." },
  "revoked": false,
  "revocation_checked": true,
  "os_version": 150000,
  "os_patch_level": 202609
}
```

`reason` is optional; `attested_ids` fields are present only when the device attested them;
`revoked` is `null` when the list was not checked.

How the app reads it (`src/device/attest-logic.ts`):

| Server answer                                                                                     | Shown                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `valid: true`, consistent                                                                         | "Genuine Android device with a hardware-backed key." (or "Genuine <attested model> ..." when attested) |
| `valid: true`, `reason: "revocation_unchecked"`                                                   | same, plus "(revocation list not checked)"                                                             |
| `valid: false`, or `valid: true` with `challenge_match: false` / `revoked: true` / software level | "Not verified: this phone did not prove a hardware-backed key." plus the reason                        |
| 404 (route switched off)                                                                          | "Device check unavailable right now." (never "not genuine")                                            |
| other HTTP error, network error, timeout, malformed body                                          | "Could not verify this device." (never "genuine")                                                      |

The challenge is currently generated on the phone. TODO: a server-issued single-use nonce is
the right design (it stops replay of a captured chain); see `src/device/attest.ts`.

## Limits

- **Risk signals, not guarantees.** A clean result means no signal was found, not that a recipient is trustworthy.
- **Known signals only.** Blocks come from catalogued drainers plus wallets whose deployer profile in SolSentry's records is HIGH or CRITICAL risk (MEDIUM risk shows a Warning). Anything SolSentry has not seen is not flagged.
- **Allow is not a guarantee.** Allow means no signal was found. An address with no on-chain history shows as a Warning, but a real wallet with no known risk shows as Allow.
- **Address poisoning is a string check.** It compares the recipient with your own contacts only (past Allow checks and your wallet's recent SOL recipients), so a lookalike of an address you never used is not caught. History Re-check uses the same contacts.
- **One check at a time.** A QR scanned while another check is still running fills the form but is not checked; tap Check. Sending always needs a current verdict for the exact address.
- **Source of funds is one hop.** Only the wallet's first funder is looked up; long histories (more than 5,000 signatures) and wallets without a plain funding transfer come back as "not determined".
- The public Solana RPC is rate limited. If it refuses the source-of-funds lookup, the check fails closed.
- SOL transfers only in this version (Solana Pay SPL token requests are checked, not sent). The Mobile Wallet Adapter path was not exercised end to end in CI: it needs a wallet app on a device.

## Build

Requirements: Node 20+, JDK 17 or 21, Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1).

```bash
npm install
npm run typecheck && npm test

npx expo prebuild -p android
export JAVA_HOME=/path/to/jdk ANDROID_HOME=/path/to/android-sdk
cd android && NODE_ENV=production ./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

**`solana:` links are opt-in.** Build with `SOLANA_PAY_INTENT=1 npx expo prebuild -p android` to register the `solana:` intent filter (see `app.config.js`). It is off by default because wallet apps register the same scheme: Android then shows a chooser or keeps routing links to the app picked as default, which can get between the user and their wallet. The in-app QR scanner works either way.

Release signing uses a keystore **outside the repository**. `plugins/with-release-signing.js` reads `~/.keys/solsentry-guard-mobile/keystore.properties` (or the path in `KEYSTORE_PROPERTIES`) with `storeFile`, `keyAlias`, `storePassword`, `keyPassword`, and the release build fails if it is missing. Create your own:

```bash
keytool -genkeypair -keystore ~/.keys/solsentry-guard-mobile/release.keystore \
  -alias solsentry-guard -keyalg RSA -keysize 2048 -validity 10000
```

Install on a device or emulator with an MWA-compatible wallet (for example the Solana Mobile mock wallet, Phantom or Solflare):

```bash
adb install -r app-release.apk
```

## Credits

- Guard checks vendored from [github.com/solsentry/solsentry-guard](https://github.com/solsentry/solsentry-guard) (MIT), commit `cc04bd1`, into `src/guard/`.
- Scaffolded from Solana Mobile's `web3js-expo-minimal` template (`create-solana-dapp`).
- Mobile Wallet Adapter by Solana Mobile.

## License

MIT
