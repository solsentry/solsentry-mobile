"""Immutable epoch-table and certificate artifacts for the phone relay.

No network, keys, scheduling, signing or implicit trust. Existing artifacts with
different bytes are never replaced. A manifest describes provenance, not authority.
"""
import argparse
import base64
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile

U64_MAX = (1 << 64) - 1


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def immutable(path, data):
    """Publish a complete file with atomic no-replace semantics, even under races."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(temp, path)
            return True
        except FileExistsError:
            require(bounded_read(path, len(data)) == data, f'Conflicting artifact: {path}')
            return False
    finally:
        os.unlink(temp)


def bounded_read(path, limit):
    with Path(path).open('rb') as f:
        data = f.read(limit + 1)
    require(len(data) <= limit, 'Input size limit exceeded')
    return data


def bind_archive(output, cluster, shred, slots_per_epoch=432000, first_normal_epoch=0, first_normal_slot=0):
    require(cluster in ('mainnet-beta', 'devnet') and type(shred) is int and 0 <= shred <= 65535, 'Invalid archive network')
    immutable(Path(output) / 'network.json', canonical({'schema': 1, 'cluster': cluster, 'shred_version': shred,
        'slots_per_epoch': slots_per_epoch, 'first_normal_epoch': first_normal_epoch, 'first_normal_slot': first_normal_slot}))


def table_bytes(rows, epoch, cluster, shred, slots_per_epoch=432000, first_normal_epoch=0, first_normal_slot=0):
    from py_ecc.bls import G2ProofOfPossession as bls
    require(0 <= epoch <= U64_MAX and 0 <= shred <= 65535, 'Invalid table metadata')
    require(cluster in ('mainnet-beta', 'devnet'), 'Invalid cluster')
    require(isinstance(rows, list) and 0 < len(rows) <= 2000, 'Invalid vote-account count')
    candidates = []
    votes = set()
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('vote'), str), 'Invalid vote account')
        require(row['vote'] not in votes, 'Duplicate vote account')
        votes.add(row['vote'])
        stake = row['stake']
        require(type(stake) is int and 0 <= stake <= U64_MAX, 'Invalid stake')
        raw = base64.b64decode(row['data'], validate=True)
        require(len(raw) >= 4 and type(row['ver']) is int and struct.unpack_from('<I', raw)[0] == row['ver'], 'Vote version mismatch')
        if row['ver'] in (1, 2):
            require(len(raw) in (3731, 3762), 'Unsupported legacy vote-account layout')
            continue  # Legacy versions have no BLS registration.
        require(len(raw) == 3762 and row['ver'] == 3, 'Unsupported vote-account layout')
        require(raw[144] in (0, 1), 'Invalid BLS option')
        if not stake or not raw[144]:
            continue
        key = raw[145:193]
        # Snapshot V4 represents on-chain PoP registration. Point validity does
        # not establish that the untrusted snapshot itself is authentic.
        require(bls.KeyValidate(key), 'Invalid BLS key')
        candidates.append((stake, key, raw[4:36]))
    keys = Counter(r[1] for r in candidates)
    nodes = Counter(r[2] for r in candidates)
    ranked = sorted((r for r in candidates if keys[r[1]] == 1 and nodes[r[2]] == 1), key=lambda r: (-r[0], r[1]))
    require(0 < len(ranked) <= 2000 and 0 < sum(r[0] for r in ranked) <= U64_MAX, 'Invalid total stake')
    first_slot = first_normal_slot + (epoch - first_normal_epoch) * slots_per_epoch
    require(0 <= first_slot <= U64_MAX and 0 < slots_per_epoch < 1 << 32, 'Invalid epoch schedule')
    header = struct.pack('<4sBBHQQIHH', b'SSET', 1, int(cluster == 'devnet'), shred, epoch, first_slot, slots_per_epoch, len(ranked), 0)
    return header + b''.join(key + struct.pack('<Q', stake) for stake, key, _ in ranked)


def archive_table(source, output, epoch, cluster, shred, provenance, **schedule):
    bind_archive(output, cluster, shred, **schedule)
    raw = bounded_read(source, 16 << 20)
    table = table_bytes(json.loads(raw), epoch, cluster, shred, **schedule)
    directory = Path(output) / 'epochs' / str(epoch)
    immutable(directory / 'table.bin', table)
    manifest = {
        'schema': 1, 'epoch': epoch, 'cluster': cluster, 'shred_version': shred,
        'table_sha256': digest(table), 'bytes': len(table), 'validators': (len(table) - 32) // 56,
        'source_sha256': digest(raw), 'provenance': provenance,
        'trust': 'unverified-source',
    }
    # Different provenance reports for identical tables can coexist.
    report = canonical(manifest)
    immutable(directory / 'provenance' / (digest(report) + '.json'), report)
    return manifest


def normalize_certificate(value):
    require(isinstance(value, dict), 'Certificate object required')
    cert = value.get('final_cert', value)
    require(isinstance(cert, dict) and type(cert.get('slot')) is int and 0 <= cert['slot'] <= (1 << 53) - 1, 'Invalid cert slot')
    def aggregate(a):
        require(isinstance(a, dict) and type(a.get('kind')) is int and a['kind'] == 0, 'Unsupported signature kind')
        result = {'kind': 0}
        for name, lengths in [('sig', (96,)), ('block_id', (0, 32)), ('bitmap', range(3, 404))]:
            encoded = a.get(name)
            require(isinstance(encoded, str) and len(encoded) <= 540, 'Invalid aggregate field')
            decoded = base64.b64decode(encoded, validate=True)
            require(len(decoded) in lengths and base64.b64encode(decoded).decode() == encoded, 'Invalid aggregate encoding')
            result[name] = encoded
        return result
    final = aggregate(cert.get('final'))
    notar = None if cert.get('notar') is None else aggregate(cert['notar'])
    require((notar is None and len(base64.b64decode(final['block_id'])) == 32) or
            (notar is not None and final['block_id'] == '' and len(base64.b64decode(notar['block_id'])) == 32), 'Invalid finalization shape')
    return {'slot': cert['slot'], 'final': final, 'notar': notar}


def archive_certificate(value, output, cluster, shred):
    bind_archive(output, cluster, shred)
    cert = normalize_certificate(value)
    data = canonical(cert)
    root = Path(output)
    immutable(root / 'certificate-variants' / str(cert['slot']) / (digest(data) + '.json'), data)
    # A single slot may have different valid aggregates. Retain all variants;
    # serve the first observation without overwriting it or calling it verified.
    path = root / 'certificates' / (str(cert['slot']) + '.json')
    if not path.exists():
        try:
            immutable(path, data)
        except ValueError:
            require(path.exists(), 'Certificate publication failed')
    return cert['slot'], digest(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    t = sub.add_parser('table')
    t.add_argument('source'); t.add_argument('--output', required=True)
    t.add_argument('--epoch', required=True, type=int)
    t.add_argument('--cluster', required=True, choices=['mainnet-beta', 'devnet'])
    t.add_argument('--shred-version', required=True, type=int)
    t.add_argument('--provenance', required=True, help='Public source description; never credentials')
    t.add_argument('--slots-per-epoch', type=int, default=432000)
    t.add_argument('--first-normal-epoch', type=int, default=0)
    t.add_argument('--first-normal-slot', type=int, default=0)
    c = sub.add_parser('certificates')
    c.add_argument('source'); c.add_argument('--output', required=True)
    c.add_argument('--cluster', required=True, choices=['mainnet-beta', 'devnet'])
    c.add_argument('--shred-version', required=True, type=int)
    args = parser.parse_args()
    if args.command == 'table':
        print(json.dumps(archive_table(args.source, args.output, args.epoch, args.cluster, args.shred_version,
            args.provenance, slots_per_epoch=args.slots_per_epoch, first_normal_epoch=args.first_normal_epoch,
            first_normal_slot=args.first_normal_slot), sort_keys=True))
    else:
        count = 0
        with Path(args.source).open('rb') as f:
            while line := f.readline(65537):
                require(len(line) <= 65536, 'Certificate line size exceeded')
                archive_certificate(json.loads(line), args.output, args.cluster, args.shred_version)
                count += 1
                require(count <= 1000000, 'Batch limit exceeded')
        print(json.dumps({'observations_archived': count}))


if __name__ == '__main__':
    main()
