#!/usr/bin/env python3
"""File-boundary transport roundtrip and corruption checks."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import artifact_transport as transport

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    parts = [b'', b'first source\n', b'large input\n' * 4, b'last', b'']
    data = b''.join(parts)
    rows, offset = [], 0
    for i, part in enumerate(parts):
        rows.append(dict(path=f'input{i}', offset=offset, size=len(part), sha256=hashlib.sha256(part).hexdigest()))
        offset += len(part)
    manifest = dict(bundle_sha256=hashlib.sha256(data).hexdigest(), files=rows)
    source = root / 'original'
    source.write_bytes(data)
    transport.CHUNK = 10
    published = root / 'published'
    result = transport.publish_bundle(source, published, manifest)
    assert len(result['chunks']) > 1
    assert transport.logical_bytes(published / 'bundle.bin') == data
    for row in rows:
        assert any(c['offset'] <= row['offset'] and row['offset'] + row['size'] <= c['offset'] + c['size'] for c in result['chunks'])
    target = published / result['chunks'][0]['path']
    target.write_bytes(b'corrupt')
    try:
        transport.logical_bytes(published / 'bundle.bin')
    except RuntimeError:
        pass
    else:
        raise AssertionError('corrupt chunk accepted')
    result['chunks'][0]['path'] = '../escape'
    (published / 'transport.json').write_text(json.dumps(result))
    try:
        transport.logical_bytes(published / 'bundle.bin')
    except RuntimeError:
        pass
    else:
        raise AssertionError('path escape accepted')
print('PASS: transport boundaries, empty inputs, oversized inputs, checksum and path failures')
