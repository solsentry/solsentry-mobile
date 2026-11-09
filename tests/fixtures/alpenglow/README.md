# Public Alpenglow fixtures

Tables use the SSET v1 format documented in `tools/alpenglow/README.md`. They are
test inputs, not configured production trust anchors. All observations come from
public mainnet/devnet data; no provider URLs, access tokens or wallet keys appear.

| Epoch | Source                                       | Certificate observations |
| ----- | -------------------------------------------- | -----------------------: |
| 1080  | Old Faithful historical CAR                  |                       12 |
| 1081  | QuickNode Yellowstone, 2026-11-09            |                       40 |
| 1082  | QuickNode Yellowstone transition, 2026-11-09 |                       40 |
| 1204  | Helius LaserStream devnet, 2026-11-08        |                       40 |

Mainnet tables were extracted from the public bank component at slot 467382140,
SHA-256 `561f5bf9aee295729a1a506d9650dae80ee0a10d42d7ca83db1261ca211b37d0`.
Devnet table came from public RPC vote accounts. The independent Python research
verifier accepted every aggregate before these fixtures were converted for the
TypeScript verifier. Counts represent observations; a slot can occur more than once.

Each JSON fixture records the SHA-256 of its original capture, original account
table and SSET binary. Capture metadata unrelated to verification is omitted.
The binary tables contain rank-ordered compressed BLS public keys and exact stakes.
Signatures are unmodified.

`synthetic.json` contains independently generated py_ecc 8 signatures for explicit
protocol edge cases, using fixed **test-only** scalars. `table-synthetic.bin` is
their artificial stake table. These keys have no wallet or on-chain role.

Reproduce with `tools/alpenglow/make_fixtures.py RESEARCH_ROOT OUTPUT_DIRECTORY`
using the retained captures named in that script. The public fixtures themselves
are sufficient to run the repository's offline tests without those large captures.
