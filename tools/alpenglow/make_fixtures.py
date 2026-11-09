"""Reproduce public fixtures from the retained research captures and py_ecc 8.

Usage: python make_fixtures.py dist/b4_epoch tests/fixtures/alpenglow
Synthetic keys are test-only scalars and never represent on-chain wallets.
"""
import base64
import json
from pathlib import Path
import struct
import sys

from py_ecc.bls import G2ProofOfPossession as bls
from archive import canonical, digest, normalize_certificate, table_bytes


def b64(data):
    return base64.b64encode(data).decode()


def make(research, output):
    research, output = Path(research), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    jobs = [(1080, research / 'bls_verify/certs_oldfaithful_e1080.jsonl'),
            (1081, research / 'certs_quicknode_20261109T184647Z.jsonl'),
            (1082, research / 'bls_verify/certs_quicknode_e1082.jsonl'),
            (1204, research / 'certs_laserstream_20261108T230407Z.jsonl')]
    for epoch, certpath in jobs:
        devnet = epoch == 1204
        rows_path = research / ('bls_verify/devnet_vote_accts.json' if devnet else f'bls_verify/alternatives/snapshot_table_epoch{epoch}.json')
        rows = json.loads(rows_path.read_text())
        table = table_bytes(rows, epoch, 'devnet' if devnet else 'mainnet-beta', 7016 if devnet else 50093)
        (output / f'table-{epoch}.bin').write_bytes(table)
        capture = certpath.read_bytes()
        result = {'epoch': epoch, 'tableSha256': digest(table), 'captureSha256': digest(capture),
                  'sourceTableSha256': digest(rows_path.read_bytes()),
                  'certificates': [normalize_certificate(json.loads(line)) for line in capture.splitlines()]}
        (output / f'certificates-{epoch}.json').write_bytes(canonical(result))

    # Independent signatures include exact thresholds, mixed messages, and a
    # fallback-only bitmap. The phone's signing code is not used to create them.
    synthetic = []
    for i, (sk, stake) in enumerate(zip([13, 17, 19, 23, 29], [40, 20, 20, 10, 10])):
        raw = bytearray(3762)
        struct.pack_into('<I', raw, 0, 3)
        raw[4:36] = bytes([i + 1]) * 32
        raw[144] = 1; raw[145:193] = bls.SkToPk(sk)
        synthetic.append((stake, bls.SkToPk(sk), sk, {'vote': f'test-{i}', 'stake': stake, 'ver': 3, 'data': b64(raw)}))
    synthetic.sort(key=lambda r: (-r[0], r[1]))
    table = table_bytes([r[3] for r in synthetic], 1082, 'mainnet-beta', 50093)
    (output / 'table-synthetic.bin').write_bytes(table)
    cases = []
    slot = 467424001
    for name, tags, digits, block in [
        ('fast-exact-80', [1], [1, 1, 1, 0, 0], bytes([42]) * 32),
        ('notar-exact-60', [1], [1, 1, 0, 0, 0], bytes([42]) * 32),
        ('final-exact-60', [2], [1, 1, 0, 0, 0], b''),
        ('skip-base2', [3], [1, 1, 0, 0, 0], b''),
        ('notar-fallback-mixed', [1, 4], [1, 2, 0, 0, 0], bytes([42]) * 32),
        ('skip-mixed', [3, 5], [1, 2, 0, 0, 0], b''),
        ('skip-fallback-only', [3, 5], [2, 2, 0, 0, 0], b''),
        ('fast-insufficient', [1], [1, 1, 0, 0, 0], bytes([42]) * 32),
    ]:
        payloads = [bytes([tag]) + struct.pack('<Q', slot) + block + struct.pack('<H', 50093) for tag in tags]
        signatures = [bls.Sign(synthetic[i][2], payloads[d - 1]) for i, d in enumerate(digits) if d]
        signature = bls.Aggregate(signatures)
        keys = [synthetic[i][1] for i, d in enumerate(digits) if d]
        messages = [payloads[d - 1] for d in digits if d]
        if len(tags) == 1:
            assert bls.FastAggregateVerify(keys, payloads[0], signature)
            bitmap = bytes([0, 5, 0, sum((d > 0) << i for i, d in enumerate(digits))])
        else:
            assert bls.AggregateVerify(keys, messages, signature)
            bitmap = bytes([1, 5, 0, sum(d * 3**i for i, d in enumerate(digits))])
        cases.append({'name': name, 'slot': slot, 'aggregate': {'kind': 0, 'sig': b64(signature), 'block_id': b64(block), 'bitmap': b64(bitmap)}})
    (output / 'synthetic.json').write_bytes(canonical(cases))


if __name__ == '__main__':
    make(*sys.argv[1:])
