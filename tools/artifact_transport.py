"""Read and publish frozen binary bundles within static-host file limits."""
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath

LIMIT = 25 * 1024 * 1024
CHUNK = 16 * 1024 * 1024


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def logical_bytes(path):
    path = Path(path)
    if path.is_file():
        data = path.read_bytes()
        return gzip.decompress(data) if data.startswith(b'\x1f\x8b') else data
    if path.name != 'bundle.bin':
        raise FileNotFoundError(path)
    transport = json.loads((path.parent / 'transport.json').read_text())
    data = bytearray()
    for row in transport['chunks']:
        relative = PurePosixPath(row['path'])
        if relative.is_absolute() or '..' in relative.parts or row['offset'] != len(data):
            raise RuntimeError('invalid bundle chunk path or bounds')
        chunk = logical_bytes(path.parent / relative)
        if len(chunk) != row['size'] or checksum(chunk) != row['sha256']:
            raise RuntimeError('bundle chunk checksum mismatch')
        data.extend(chunk)
    if len(data) != transport['bytes'] or checksum(data) != transport['sha256']:
        raise RuntimeError('bundle transport checksum mismatch')
    return bytes(data)


def publish_bundle(source, destination, manifest, *, split_large_files=False):
    """Split at file boundaries so browser workers can share each input view."""
    source, destination = Path(source), Path(destination)
    data = source.read_bytes()
    if checksum(data) != manifest['bundle_sha256']:
        raise RuntimeError('source bundle checksum mismatch')
    rows = manifest['files']
    position = 0
    boundaries = [0]
    for row in rows:
        if row['offset'] != position or row['size'] < 0:
            raise RuntimeError('bundle files do not cover the filesystem consecutively')
        if position > boundaries[-1] and position - boundaries[-1] + row['size'] > CHUNK:
            boundaries.append(position)
        if split_large_files and row['size'] > CHUNK:
            boundaries.extend(range(position + CHUNK, position + row['size'], CHUNK))
            boundaries.append(position + row['size'])
        position += row['size']
    if position != len(data):
        raise RuntimeError('bundle has unaccounted bytes')
    if boundaries[-1] != position or len(boundaries) == 1: boundaries.append(position)
    directory = destination / 'chunks'
    directory.mkdir(parents=True)
    chunks = []
    for i, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        part = data[start:end]
        encoded = gzip.compress(part, compresslevel=6, mtime=0)
        if len(encoded) > LIMIT:
            raise RuntimeError('one frozen input exceeds the static host file limit')
        name = f'chunks/bundle.{i:04}.bin'
        (destination / name).write_bytes(encoded)
        chunks.append(dict(path=name, offset=start, size=len(part), sha256=checksum(part)))
    transport = dict(schema=1, bytes=len(data), sha256=manifest['bundle_sha256'], chunks=chunks)
    if split_large_files: transport['split_files'] = True
    (destination / 'transport.json').write_text(json.dumps(transport, indent=2) + '\n')
    return transport


def publish_binary(source, destination, prefix='data'):
    """Range chunks for data files that are larger than a static-host object."""
    source,destination=Path(source),Path(destination);destination.mkdir(parents=True,exist_ok=True)
    chunks=[];whole=hashlib.sha256();offset=0
    with source.open('rb') as stream:
        while part:=stream.read(CHUNK):
            whole.update(part);encoded=gzip.compress(part,compresslevel=6,mtime=0)
            name=f'{prefix}.{len(chunks):04}.bin';(destination/name).write_bytes(encoded)
            chunks.append(dict(path=name,offset=offset,size=len(part),encoded_bytes=len(encoded),sha256=checksum(part)));offset+=len(part)
    return dict(bytes=offset,sha256=whole.hexdigest(),chunks=chunks)
