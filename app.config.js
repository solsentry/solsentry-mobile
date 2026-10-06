// Extends app.json. The `solana:` deep link is OPT-IN at build time:
//
//   SOLANA_PAY_INTENT=1 npx expo prebuild -p android
//
// Why opt-in: wallet apps (Phantom, Solflare, Seed Vault wallets) also register `solana:`.
// When several apps claim it, Android shows a chooser, or keeps sending links to whichever
// app the user picked "always" for, so registering it can get in the way of the user's
// wallet. Without the flag the app still reads Solana Pay QR codes with its own scanner.
module.exports = ({ config }) => {
  if (process.env.SOLANA_PAY_INTENT !== '1') return config
  return {
    ...config,
    android: {
      ...config.android,
      intentFilters: [
        ...(config.android?.intentFilters ?? []),
        {
          action: 'VIEW',
          category: ['DEFAULT', 'BROWSABLE'],
          data: [{ scheme: 'solana' }],
        },
      ],
    },
  }
}
