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
TypeScript verifier. Counts represent observations; a slot can occur more than once. Mainnet contains
88 distinct aggregate signatures (92 footers): 12 in epoch 1080, 38 in 1081 and
38 in 1082, deduplicated by (certificate slot, final aggregate signature).

Each JSON fixture records the SHA-256 of its original capture, original account
table and SSET binary. Capture metadata unrelated to verification is omitted.
The binary tables contain rank-ordered compressed BLS public keys and exact stakes.
Signatures are unmodified.

`table-1083.bin` and `table-1083.json` retain the following epoch's table from
public snapshot bank slot 467482256, SHA-256
`de376fcb26cfcd43f2089a1683c3b9cf523017fa0cf8ee9295104f6e1da9e630`.
It has 668 validators and SHA-256
`6ac124ae35a3672d9a93fa526f737d34f7893454d10ea7b6392cec1e3d3a88e1`.
The same bank reproduces the existing epoch-1082 table byte-for-byte. This is
corroboration, not authentication. No epoch-1083 certificate has been captured:
the added test checks parsing and rejection of old/relabelled signatures only.

`synthetic.json` contains independently generated py_ecc 8 signatures for explicit
protocol edge cases, using fixed **test-only** scalars. `table-synthetic.bin` is
their artificial stake table. These keys have no wallet or on-chain role.

Reproduce with `tools/alpenglow/make_fixtures.py RESEARCH_ROOT OUTPUT_DIRECTORY`
using the retained captures named in that script. The public fixtures themselves
are sufficient to run the repository's offline tests without those large captures.

`epoch-pins-v1.json` is the unchanged signed-policy reference dataset from commit
`9af8753ca0df064d311c295e70a9248919bfafdf`, file
`golden/epoch_tables_v1/vectors.json`. SHA-256:
`c94ea53987a6d9026377e24a0ae6a2d2f453cf07b944aa4d96f0bba19d1a07b1`.
It contains all 75 policy cases and 35 cross-feed cases. Its five `seed_hex` values
are PUBLIC test material from the five Ed25519 examples in RFC 8032 section 7.1, never real wallet/operator keys.
They must not be used for production signing or as production trust anchors.

The signed policy schema in these vectors has no `keyId` member: the reader checks
the signature against verified `use: epoch_tables` delegations. Synthetic trust
bridges in some cross-feed cases deliberately delegate a test root to itself or
use the test table public key as a floor anchor, to test schema refusal after a
valid signature. Normal root/receipt-key cases retain their ordinary trust context.
No production delegation or bank-validation evidence appears in these fixtures.
