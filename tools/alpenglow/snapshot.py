"""Bounded extraction for the observed Agave v4.4 snapshot layout.

The bank prefix is NOT a restored/validated snapshot. Outputs remain untrusted.
"""
import argparse
import base64
import hashlib
import json
import mmap
from pathlib import Path
import re
import struct
import tarfile
import time
import urllib.parse
import urllib.request

from archive import archive_table, canonical, digest, immutable, require

LIMIT = 256 << 20
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def b58(raw):
    value = int.from_bytes(raw, 'big')
    result = ''
    while value:
        value, remainder = divmod(value, 58)
        result = ALPHABET[remainder] + result
    return '1' * (len(raw) - len(raw.lstrip(b'\0'))) + result


def extract_tables(bank, epochs):
    require(0 < Path(bank).stat().st_size <= LIMIT, 'Bank size limit')
    with Path(bank).open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
        results = {}
        for epoch in epochs:
            require(type(epoch) is int and 1 <= epoch < 1 << 53, 'Invalid epoch')
            needle = struct.pack('<QI', epoch, 0)
            position = 0
            valid = []
            while (offset := data.find(needle, position)) >= 0:
                position = offset + 1
                if offset + 20 > len(data):
                    continue
                count = struct.unpack_from('<Q', data, offset + 12)[0]
                if not 0 < count <= 2000:
                    continue
                cursor = offset + 20
                rows = []
                try:
                    for _ in range(count):
                        vote = data[cursor:cursor + 32]
                        cursor += 32
                        stake, lamports, size = struct.unpack_from('<QQQ', data, cursor)
                        cursor += 24
                        require(0 < stake <= (1 << 64) - 1 and size == 3762, 'Stake/layout')
                        raw = data[cursor:cursor + size]
                        cursor += size
                        require(len(raw) == size and struct.unpack_from('<I', raw)[0] == 3, 'Vote state version')
                        owner = data[cursor:cursor + 32]
                        cursor += 32
                        require(b58(owner) == 'Vote111111111111111111111111111111111111111', 'Vote owner')
                        require(data[cursor] == 0, 'Executable vote account')
                        cursor += 9  # executable + rent_epoch
                        rows.append({'vote': b58(vote), 'stake': stake, 'lamports': lamports, 'ver': 3,
                                     'data': base64.b64encode(raw).decode()})
                    delegations, unused, captured, histories = struct.unpack_from('<QQQQ', data, cursor)
                    cursor += 32
                    require(delegations == unused == 0 and captured == epoch - 1 and histories <= 512, 'Epoch metadata')
                    cursor += histories * 32
                    total = struct.unpack_from('<Q', data, cursor)[0]
                    require(total == sum(r['stake'] for r in rows), 'Total stake mismatch')
                    require(len({r['vote'] for r in rows}) == count, 'Duplicate vote account')
                    valid.append((rows, {'bank_offset': offset, 'captured_epoch': captured, 'source_total_stake': total}))
                except (ValueError, struct.error, IndexError):
                    continue
            require(len(valid) == 1, f'Epoch {epoch}: expected exactly one validated layout candidate, found {len(valid)}')
            results[epoch] = valid[0]
        return results


class CappedReader:
    def __init__(self, reader, limit, deadline):
        self.reader, self.limit, self.deadline = reader, limit, deadline
        self.count = 0

    def read(self, size=-1):
        require(time.monotonic() < self.deadline, 'Snapshot deadline exceeded')
        require(self.count < self.limit, 'Snapshot byte cap reached')
        data = self.reader.read(min(131072 if size < 0 else size, self.limit - self.count))
        self.count += len(data)
        return data


def fetch_bank(url, output, timeout=120):
    import zstandard
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password and not parsed.query, 'Public snapshot URL required')
    deadline = time.monotonic() + timeout
    with urllib.request.urlopen(url, timeout=min(timeout, 20)) as response:
        resolved = urllib.parse.urlsplit(response.geturl())
        require(not resolved.query and not resolved.username and not resolved.password, 'Credentialed redirect rejected')
        match = re.search(r'/snapshot-(\d+)-[A-Za-z0-9]+\.tar\.zst$', resolved.path)
        require(match is not None, 'Expected full .tar.zst snapshot URL')
        slot = int(match[1])
        network = CappedReader(response, LIMIT, deadline)
        with zstandard.ZstdDecompressor().stream_reader(network) as stream:
            decoded = CappedReader(stream, 512 << 20, deadline)
            with tarfile.open(fileobj=decoded, mode='r|') as archive:
                for i, member in enumerate(archive):
                    require(i <= 10, 'Bank not near archive start')
                    if member.name != f'snapshots/{slot}/{slot}':
                        continue
                    require(member.isfile() and 0 < member.size <= LIMIT, 'Bank component size/type')
                    source = archive.extractfile(member)
                    data = bytearray()
                    while len(data) < member.size:
                        chunk = source.read(min(1 << 20, member.size - len(data)))
                        require(chunk, 'Truncated bank')
                        data.extend(chunk)
                    bank_hash = digest(data)
                    path = Path(output) / 'banks' / (bank_hash + '.bin')
                    immutable(path, data)
                    provenance = {'url': response.geturl(), 'slot': slot, 'sha256': bank_hash,
                                  'network_bytes': network.count, 'bank_bytes': len(data), 'trust': 'unverified-source'}
                    immutable(path.with_suffix('.json'), canonical(provenance))
                    return path
    raise ValueError('Bank component not found')


def preserve(bank, output, epochs, cluster, shred, **schedule):
    # Hash without loading another copy of a potentially large bank into memory.
    require(0 < Path(bank).stat().st_size <= LIMIT, 'Bank size limit')
    with Path(bank).open('rb') as f:
        bank_hash = hashlib.file_digest(f, 'sha256').hexdigest()
    tables = extract_tables(bank, epochs)
    reports = []
    for epoch, (rows, metadata) in tables.items():
        source = Path(output) / 'source-tables' / f'{bank_hash}-{epoch}.json'
        immutable(source, canonical(rows))
        provenance = {'bank_sha256': bank_hash, 'parser': 'agave-v4.4-observed-layout-v1', **metadata}
        reports.append(archive_table(source, output, epoch, cluster, shred, provenance, **schedule))
    return reports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--bank'); source.add_argument('--url')
    parser.add_argument('--output', required=True)
    parser.add_argument('--epochs', type=int, nargs='+', required=True)
    parser.add_argument('--cluster', choices=['mainnet-beta', 'devnet'], required=True)
    parser.add_argument('--shred-version', type=int, required=True)
    args = parser.parse_args()
    bank = args.bank or fetch_bank(args.url, args.output)
    print(json.dumps(preserve(bank, args.output, args.epochs, args.cluster, args.shred_version), sort_keys=True))


if __name__ == '__main__':
    main()
