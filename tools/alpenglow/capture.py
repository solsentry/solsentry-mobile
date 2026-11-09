"""Bounded Yellowstone capture with immutable per-slot artifacts.

Credentials only from environment; no keys/URLs in artifacts or diagnostics.
Optional public snapshot source preserves the observed epoch and its successor.
Run repeatedly under the deployment's scheduler, with a trial deadline configured.
"""
import argparse
import base64
from datetime import datetime, timezone
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit

from archive import archive_certificate, bind_archive, canonical, immutable, require


def table_coverage(output, epochs, snapshot_url, cluster, shred):
    """Record acquisition failures without losing the capture's final report.

    Presence means retained bytes only, never authentication or verification.
    """
    required = sorted(epochs | ({max(epochs) + 1} if epochs else set()))
    preserved, errors = [], []
    if snapshot_url and required:
        from snapshot import fetch_bank, preserve
        try:
            bank = fetch_bank(snapshot_url, output)
        except Exception as error:
            # URL/library messages can contain credentials; persist types only.
            errors.append({'stage': 'snapshot', 'error_type': type(error).__name__})
        else:
            for epoch in required:
                try:
                    preserved.extend(preserve(bank, output, [epoch], cluster, shred))
                except Exception as error:
                    errors.append({'stage': 'table', 'epoch': epoch, 'error_type': type(error).__name__})
    present = [epoch for epoch in required if (Path(output) / 'epochs' / str(epoch) / 'table.bin').is_file()]
    return {'tables_preserved': [t['epoch'] for t in preserved], 'tables_present': present,
            'missing_epochs': sorted(set(required) - set(present)), 'table_errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proto-dir', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--rpc-url-env', default='QUICKNODE_PAID_RPC_URL')
    parser.add_argument('--cluster', required=True, choices=['mainnet-beta', 'devnet'])
    parser.add_argument('--shred-version', type=int, required=True)
    parser.add_argument('--max-certificates', type=int, default=40)
    parser.add_argument('--timeout', type=int, default=120)
    parser.add_argument('--not-after', required=True, help='Explicit UTC cutoff, e.g. 2026-11-12T00:00:00Z')
    parser.add_argument('--from-slot', type=int)
    parser.add_argument('--snapshot-url', help='Public .tar.zst URL or redirect; no credentials')
    args = parser.parse_args()
    cutoff = datetime.fromisoformat(args.not_after.replace('Z', '+00:00'))
    require(cutoff.tzinfo is not None and cutoff.utcoffset().total_seconds() == 0, 'UTC cutoff required')
    remaining = cutoff.timestamp() - time.time()
    require(remaining > 0, 'Capture access cutoff reached; no connection opened')
    require(1 <= args.max_certificates <= 100000 and 1 <= args.timeout <= 3600, 'Capture limits')
    bind_archive(args.output, args.cluster, args.shred_version)
    url = urlsplit(os.environ[args.rpc_url_env])
    require(url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.query, 'HTTPS RPC URL required')
    token = url.path.strip('/').split('/')[0]
    require(token, 'RPC token missing')
    target = f'{url.hostname}:443'
    sys.path.insert(0, str(Path(args.proto_dir).resolve()))
    import grpc
    g = importlib.import_module('geyser_pb2')
    gg = importlib.import_module('geyser_pb2_grpc')
    request = g.SubscribeRequest(
        block_footer={'certificates': g.SubscribeRequestFilterBlockFooter(include_certificates=True)},
        commitment=g.CommitmentLevel.CONFIRMED,
    )
    if args.from_slot is not None:
        require(0 <= args.from_slot < 1 << 53, 'Replay slot')
        request.from_slot = args.from_slot
    stop = threading.Event()
    def requests():
        yield request
        while not stop.wait(10):
            yield g.SubscribeRequest(ping=g.SubscribeRequestPing(id=1))
    def aggregate(a):
        return {'kind': a.signature_kind, 'sig': base64.b64encode(a.signature).decode(),
                'block_id': base64.b64encode(a.block_id).decode(), 'bitmap': base64.b64encode(a.signer_bitmap).decode()} if a.ByteSize() else None
    # Setup/import time must not extend the provider access window.
    remaining = cutoff.timestamp() - time.time()
    require(remaining > 0, 'Capture access cutoff reached; no connection opened')
    channel = grpc.secure_channel(target, grpc.ssl_channel_credentials(), compression=grpc.Compression.Gzip,
                                  options=[('grpc.max_receive_message_length', 1 << 20)])
    count = 0
    epochs = set()
    status = 'ok'
    start = time.monotonic()
    try:
        stream = gg.GeyserStub(channel).Subscribe(requests(), metadata=(('x-token', token),), timeout=min(args.timeout, remaining))
        for update in stream:
            if update.WhichOneof('update_oneof') != 'block_footer':
                continue
            cert = update.block_footer.block_final_cert
            if not cert.ByteSize():
                continue
            value = {'slot': cert.slot, 'final': aggregate(cert.final_aggregate), 'notar': aggregate(cert.notar_aggregate)}
            archive_certificate(value, args.output, args.cluster, args.shred_version)
            # Current mainnet/devnet normal schedule. Do not accept a remote epoch field.
            epoch = cert.slot // 432000
            epochs.add(epoch)
            count += 1
            if count >= args.max_certificates:
                stream.cancel()
                break
    except grpc.RpcError as error:
        # Error details can echo metadata; only the status code is safe to persist.
        status = error.code().name
    finally:
        stop.set()
        channel.close()
    coverage = table_coverage(args.output, epochs, args.snapshot_url, args.cluster, args.shred_version)
    if status == 'ok' and (coverage['missing_epochs'] or coverage['table_errors']):
        status = 'table-unavailable'
    report = {'schema': 1, 'cluster': args.cluster, 'shred_version': args.shred_version,
              'observations': count, 'epochs': sorted(epochs), 'status': status,
              'elapsed_seconds': round(time.monotonic() - start, 3), **coverage,
              'table_trust': 'unverified-source', 'not_after': args.not_after}
    name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    immutable(Path(args.output) / 'capture-reports' / f'{name}.json', canonical(report))
    print(json.dumps(report, sort_keys=True))
    return 0 if status == 'ok' and count else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Do not leak URL/token values through library exception messages.
        print(json.dumps({'status': 'capture-failed', 'error_type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
