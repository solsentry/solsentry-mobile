import base64
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from archive import archive_certificate, archive_table, bind_archive, canonical, digest, immutable, table_bytes
from snapshot import extract_tables
from capture import table_coverage

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests/fixtures/alpenglow'


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_immutable_idempotence_and_conflicts(self):
        path = self.root / 'artifact'
        self.assertTrue(immutable(path, b'original'))
        self.assertFalse(immutable(path, b'original'))
        with self.assertRaises(ValueError):
            immutable(path, b'changed')
        self.assertEqual(path.read_bytes(), b'original')
        self.assertFalse(list(self.root.glob('.pending-*')))

    def test_archive_network_cannot_be_replaced(self):
        bind_archive(self.root, 'mainnet-beta', 50093)
        for cluster, shred in [('devnet', 50093), ('mainnet-beta', 50094)]:
            with self.assertRaises(ValueError):
                bind_archive(self.root, cluster, shred)

    def test_certificate_target_slot_and_variants_are_preserved(self):
        cert = json.loads((FIXTURES / 'certificates-1082.json').read_text())['certificates'][0]
        first = archive_certificate({'slot': cert['slot'] + 1, 'final_cert': cert}, self.root, 'mainnet-beta', 50093)
        archive_certificate(cert, self.root, 'mainnet-beta', 50093)
        changed = json.loads(json.dumps(cert))
        signature = bytearray(base64.b64decode(changed['final']['sig'])); signature[20] ^= 1
        changed['final']['sig'] = base64.b64encode(signature).decode()
        second = archive_certificate(changed, self.root, 'mainnet-beta', 50093)
        self.assertNotEqual(first[1], second[1])
        self.assertEqual(json.loads((self.root / 'certificates' / f'{cert["slot"]}.json').read_text()), cert)
        self.assertEqual(len(list((self.root / 'certificate-variants' / str(cert['slot'])).glob('*.json'))), 2)
        self.assertFalse((self.root / 'certificates' / f'{cert["slot"] + 1}.json').exists())

    def test_malformed_certificate_does_not_publish(self):
        cert = json.loads((FIXTURES / 'certificates-1082.json').read_text())['certificates'][0]
        for patch in [{'slot': -1}, {'slot': True}, {'final': None}, {'notar': cert['final']}]:
            with self.assertRaises((ValueError, TypeError)):
                archive_certificate({**cert, **patch}, self.root, 'mainnet-beta', 50093)
        self.assertFalse((self.root / 'certificates').exists())

    def rows(self):
        table = (FIXTURES / 'table-synthetic.bin').read_bytes()
        rows = []
        for i in range(5):
            offset = 32 + i * 56
            raw = bytearray(3762); struct.pack_into('<I', raw, 0, 3)
            raw[4:36] = bytes([i + 1]) * 32; raw[144] = 1; raw[145:193] = table[offset:offset + 48]
            rows.append({'vote': f'v{i}', 'stake': struct.unpack_from('<Q', table, offset + 48)[0], 'ver': 3,
                         'data': base64.b64encode(raw).decode()})
        return rows

    def test_ranking_and_duplicate_identity_exclusion(self):
        rows = self.rows()
        self.assertEqual(table_bytes(list(reversed(rows)), 1082, 'mainnet-beta', 50093), (FIXTURES / 'table-synthetic.bin').read_bytes())
        duplicate = dict(rows[0], vote='another-vote')
        table = table_bytes(rows + [duplicate], 1082, 'mainnet-beta', 50093)
        self.assertEqual(struct.unpack_from('<H', table, 28)[0], 4)  # both copies are dropped
        rows[0]['stake'] = -1
        with self.assertRaises(ValueError):
            table_bytes(rows, 1082, 'mainnet-beta', 50093)

    def test_provenance_is_content_addressed_and_never_promotes_trust(self):
        source = self.root / 'rows.json'
        source.write_bytes(canonical(self.rows()))
        report = archive_table(source, self.root, 1082, 'mainnet-beta', 50093, {'source': 'test'})
        self.assertEqual(report['trust'], 'unverified-source')
        self.assertEqual(report['table_sha256'], digest((FIXTURES / 'table-synthetic.bin').read_bytes()))

    def bank_bytes(self):
        alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        number = 0
        for char in 'Vote111111111111111111111111111111111111111':
            number = number * 58 + alphabet.index(char)
        owner = number.to_bytes(32, 'big')
        rows = self.rows()
        data = struct.pack('<QIQ', 1082, 0, len(rows))
        for i, row in enumerate(rows):
            data += bytes([i + 1]) * 32 + struct.pack('<QQQ', row['stake'], 2000000000, 3762)
            data += base64.b64decode(row['data']) + owner + b'\0' + struct.pack('<Q', 0)
        data += struct.pack('<QQQQQ', 0, 0, 1081, 0, sum(r['stake'] for r in rows))
        return data

    def test_snapshot_parser_requires_unique_complete_candidate(self):
        bank = self.root / 'bank.bin'
        original = self.bank_bytes()
        bank.write_bytes(b'prefix' + original)
        result = extract_tables(bank, [1082])
        self.assertEqual(len(result[1082][0]), 5)
        wrong_owner = bytearray(original)
        wrong_owner[20 + 32 + 24 + 3762] ^= 1
        for data in [original[:-1], original + original, original[:10], bytes(wrong_owner), original[:-8] + struct.pack('<Q', 1)]:
            bank.write_bytes(data)
            with self.assertRaises(ValueError):
                extract_tables(bank, [1082])

    def test_expired_capture_fails_before_reading_credentials_or_connecting(self):
        result = subprocess.run([sys.executable, str(ROOT / 'tools/alpenglow/capture.py'),
            '--proto-dir', str(self.root / 'no-protos'), '--output', str(self.root / 'no-archive'),
            '--cluster', 'mainnet-beta', '--shred-version', '50093', '--not-after', '2000-01-01T00:00:00Z'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {'status': 'capture-failed', 'error_type': 'ValueError'})
        self.assertFalse((self.root / 'no-archive').exists())

    def test_missing_current_and_future_tables_alert_without_snapshot_source(self):
        result = table_coverage(self.root, {1081, 1082}, None, 'mainnet-beta', 50093)
        self.assertEqual(result['missing_epochs'], [1081, 1082, 1083])
        path = self.root / 'epochs/1082/table.bin'
        path.parent.mkdir(parents=True)
        path.write_bytes((FIXTURES / 'table-1082.bin').read_bytes())
        result = table_coverage(self.root, {1082}, None, 'mainnet-beta', 50093)
        self.assertEqual(result['tables_present'], [1082])
        self.assertEqual(result['missing_epochs'], [1083])

    def test_snapshot_failure_is_sanitized_and_preserves_capture_report_data(self):
        with patch('snapshot.fetch_bank', side_effect=TimeoutError('https://secret/token')):
            result = table_coverage(self.root, {1082}, 'https://example.com', 'mainnet-beta', 50093)
        self.assertEqual(result['missing_epochs'], [1082, 1083])
        self.assertEqual(result['table_errors'], [{'stage': 'snapshot', 'error_type': 'TimeoutError'}])
        self.assertNotIn('secret', json.dumps(result))

    def test_table_failure_does_not_skip_other_epochs(self):
        def preserve(_bank, _output, epochs, _cluster, _shred):
            if epochs == [1082]:
                raise ValueError('missing layout')
            return [{'epoch': epochs[0]}]
        with patch('snapshot.fetch_bank', return_value='bank.bin'), patch('snapshot.preserve', side_effect=preserve):
            result = table_coverage(self.root, {1081, 1082}, 'https://example.com', 'mainnet-beta', 50093)
        self.assertEqual(result['tables_preserved'], [1081, 1083])
        self.assertEqual(result['table_errors'], [{'stage': 'table', 'epoch': 1082, 'error_type': 'ValueError'}])


if __name__ == '__main__':
    unittest.main()
