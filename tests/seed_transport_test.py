"""Large executable delivery reconstructs exactly within static file limits."""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from seed_prepare import prepare

with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary)
    llvm=root/'llvm';llvm.mkdir()
    binaries=root/'bin';binaries.mkdir()
    data=b'\0asm' + bytes(range(256))*70000
    runtime=b'export default function() {}'
    manifest={'revision':'test','runtime':{}}
    for name, filename in [('clang','clang-lld.wasm'),('lld','lld.wasm')]:
        (binaries/filename).write_bytes(data)
        manifest[name]={'sha256':hashlib.sha256(data).hexdigest()}
        manifest['runtime'][name]={'path':name+'.mjs','sha256':hashlib.sha256(runtime).hexdigest()}
        (llvm/(name+'.mjs')).write_bytes(runtime)
    (llvm/'manifest.json').write_text(json.dumps(manifest))
    output=root/'output'
    record=prepare(llvm,binaries,output)
    for tool in record['tools'].values():
        assert len(tool['chunks'])==2
        result=b''
        for chunk in tool['chunks']:
            encoded=(output/chunk['path']).read_bytes()
            assert len(encoded)==chunk['encoded_bytes'] and len(encoded)<25*1024*1024
            part=gzip.decompress(encoded)
            assert len(part)==chunk['size'] and hashlib.sha256(part).hexdigest()==chunk['sha256']
            result+=part
        assert result==data
    (binaries/'clang-lld.wasm').write_bytes(b'changed')
    try:
        prepare(llvm,binaries,root/'bad')
    except ValueError:
        pass
    else:
        raise AssertionError('an unqualified compiler was packaged')
print('PASS: multi-chunk executable reconstruction, encoded download sizes and seed provenance checks')
