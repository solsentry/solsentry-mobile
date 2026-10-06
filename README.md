# SolSentry Guard (mobile)

> Know who gets paid before the money moves.

An Android app that checks **who receives** a payment, and **where your own money came from**, before your wallet is asked to sign. It is the mobile version of the pre-sign checks in [`@solsentry/guard`](https://github.com/solsentry/solsentry-guard), which ran on Solana mainnet on 2026-10-03.

Package id `app.solsentry.guard`. Built with Expo / React Native and Solana Mobile's Mobile Wallet Adapter (MWA).

## What it does

- **Check & Send.** Paste a recipient address and an amount in SOL. "Check recipient" asks the SolSentry API about the address and shows a verdict card with the decision in words (Allow, Warning, Block), the explanation from the guard, and a timestamp.
  - **Allow**: "Send with wallet" is enabled.
  - **Warning**: the send button stays disabled until you switch on "I reviewed this recipient".
  - **Block**: sending is disabled. The app shows "Stopped: nothing was built or signed."
- **Where did my money come from?** After you connect a wallet, the app looks up the wallet's first funder (one hop back, via Solana RPC), screens both the wallet and that funder, and shows the verdict.
- **History.** Addresses you checked, kept on the device (AsyncStorage), each with its verdict, date and a "Re-check" button. Re-check before you pay the same address again: signals change.

## How it works

1. **Check before sign.** The recipient check runs before any transaction exists. A transaction is built only after an Allow (or a reviewed Warning), and the verdict must be for the exact address in the field and less than 5 minutes old.
2. **Fail closed.** If a check cannot run (API down, timeout, bad response, RPC error), the verdict is Block and the reason is shown. The vendored guard defaults to `onCheckError: "block"`; any unrecognised decision is also mapped to Block.
3. **MWA signs.** The app calls `authorize` and `signAndSendTransactions` through `@solana-mobile/mobile-wallet-adapter-protocol-web3js`, building one `SystemProgram.transfer` from the authorized account. There is no key handling, seed, or custody in this app: your wallet app signs.

Config lives in `src/config.ts`: `CLUSTER` (default `mainnet-beta`), `RPC_URL` (`https://api.mainnet-beta.solana.com`) and `API_BASE` (`https://api.solsentry.app`).

## Limits

- **Risk signals, not guarantees.** A clean result means no signal was found, not that a recipient is trustworthy.
- **Known signals only.** Blocks come from catalogued drainers plus wallets whose deployer profile in SolSentry's records is HIGH or CRITICAL risk (MEDIUM risk shows a Warning). Anything SolSentry has not seen is not flagged.
- **Allow is not a guarantee.** Allow means no signal was found. An address with no on-chain history shows as a Warning, but a real wallet with no known risk shows as Allow.
- **Source of funds is one hop.** Only the wallet's first funder is looked up; long histories (more than 5,000 signatures) and wallets without a plain funding transfer come back as "not determined".
- The public Solana RPC is rate limited. If it refuses the source-of-funds lookup, the check fails closed.
- SOL transfers only in this version. The Mobile Wallet Adapter path was not exercised end to end in CI: it needs a wallet app on a device.

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
