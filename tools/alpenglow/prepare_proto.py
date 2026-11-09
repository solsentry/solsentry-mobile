"""Fetch hash-pinned public schemas and generate local Yellowstone Python bindings."""
import argparse
import importlib.metadata
from importlib.resources import files
import json
from pathlib import Path
import tempfile
import urllib.request

from archive import canonical, digest, immutable, require

COMMIT = 'b408d1fa01458b90818fc4ba99831a6b254cbf26'
SCHEMAS = {
    'geyser.proto': '80ee337f361198a0722cb5bdf244fe41838949ab7a3af6d1b182b7fdca9abf02',
    'solana-storage.proto': 'e5d16ba9a9e83f6ed8c92a96b6b75dfd64c43f897b976011eb3ec5abe2f3c818',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    target = Path(args.output).resolve()
    for name, expected in SCHEMAS.items():
        if (target / name).exists():
            data = (target / name).read_bytes()
        else:
            url = f'https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/{COMMIT}/yellowstone-grpc-proto/proto/{name}'
            with urllib.request.urlopen(url, timeout=20) as response:
                data = response.read(65537)
        require(len(data) <= 65536 and digest(data) == expected, 'Schema size/hash mismatch')
        immutable(target / name, data)
    from grpc_tools import protoc
    with tempfile.TemporaryDirectory(prefix='alpenglow-proto-') as temporary:
        result = protoc.main(['grpc_tools.protoc', '-I' + str(target), '-I' + str(files('grpc_tools') / '_proto'),
                              '--python_out=' + temporary, '--grpc_python_out=' + temporary,
                              *(str(target / name) for name in SCHEMAS)])
        require(result == 0, 'Protobuf compilation failed')
        for path in Path(temporary).glob('*.py'):
            immutable(target / path.name, path.read_bytes())
    provenance = {'commit': COMMIT, 'schema_sha256': SCHEMAS,
                  'grpcio_tools': importlib.metadata.version('grpcio-tools'),
                  'protobuf': importlib.metadata.version('protobuf')}
    immutable(target / 'provenance.json', canonical(provenance))
    print(json.dumps(provenance, sort_keys=True))


if __name__ == '__main__':
    main()
