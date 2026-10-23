# Changelog

Every SolSentry Android release, newest first. Each version has an APK and its sha256 on the
[Releases](https://github.com/solsentry/solsentry-mobile/releases) page. All builds are signed with the same key
(certificate SHA-256 `6C:3D:54:55:14:FA:46:37:83:07:AF:59:61:8E:99:1A:82:C5:B0:C0:30:A8:D0:1C:80:16:58:65:55:89:42:50`),
so a newer APK installs over an older one and keeps the phone's data.

**The build judged in Solana Mobile Clock In is 0.1.22**, tag
[`clockin-2026-10-12`](https://github.com/solsentry/solsentry-mobile/tree/clockin-2026-10-12). That tag and its
release never change. Later versions are optional updates: the app offers them on its home screen, and nobody has
to install them.

## 0.1.24 (pre-release, October 23, 2026)

Optional update. The judged build 0.1.22 keeps working.

- Points: with a wallet linked, the main figure is the wallet's total (your account), and this phone's own total
  follows it. Points never move between phone and wallet; this only changes which total leads.
- Device check: on first run the app also sends a SHA-256 of Android's `ANDROID_ID`. Android scopes that id to
  this app's signing key, so other apps cannot match it, and it stays the same across a reinstall on the same phone.
  The raw id never leaves the phone. SolSentry uses it only to tell a reinstall from a new phone. It blocks no one.

## 0.1.23 (October 18, 2026)

Optional update. The judged build 0.1.22 keeps working.

Our Clock In submission listed 10 client issues from an internal code review as confirmed and queued. This
update fixes 8 of them. The other 2 need a native Android change and will come in a later release.

**Fixed from the review**
- Claim: the app refuses a claim transaction whose priority fee is above 0.001 SOL, so a server could never
  make the wallet pay a large fee.
- Claim: the balance and account reads before a claim time out, so the claim sheet can no longer stay on
  "Waiting for the wallet…".
- Storage: if the phone fails to read stored data, the app no longer overwrites history and settings with
  defaults or deletes saved RPC keys.
- RPC test: a result is dropped if the RPC URL or key changed while the test was running.
- Pace: choosing a faster pace takes effect at once. Waits SolSentry asks for, after a push-back or at the daily
  cap, stay as they are.
- Battery: the rate dial stops animating when the screen is not visible.
- Notification: it says why verification is waiting (Wi-Fi, charger) instead of "Verification is on".
- Home: the "+SKR" credit toast no longer gets stuck on screen.

**Other fixes**
- Own RPC without a URL: the app used to show "Verifying" while it read nothing. It now stops, shows
  "Setup needed", and offers "Add your RPC URL" or "Use SolSentry RPC". Saving a URL starts verification
  again.
- Unsent claim: if a claim is cancelled in the wallet, the home screen now explains that the SKR is held for
  that claim and that nothing was paid. On the server side (all app versions, 0.1.22 included), a claim that
  expired unsent is now released the next time the balance is read, so the SKR shows again within a minute or two.
- Build: `tools/build_apk.sh` refuses to overwrite an existing APK.

**Still queued:** two native fixes to the background service (one possible double start, and a wake lock held
for the whole time verification is on).

## 0.1.22 (October 12, 2026): Clock In snapshot

The build submitted to Solana Mobile Clock In: tag
[`clockin-2026-10-12`](https://github.com/solsentry/solsentry-mobile/tree/clockin-2026-10-12), release
[SolSentry 0.1.22 (Clock In snapshot)](https://github.com/solsentry/solsentry-mobile/releases/tag/clockin-2026-10-12),
sha256 `37e3ff4ff2f5b61a42757000c234da4348ac3d1514a1f8da0f530dd655f74d19`.

Home screen widget with verification status, balance and today's count. The home screen points to the own-RPC
bonus.
