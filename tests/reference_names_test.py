"""Both renamed and historical reference exports preserve hash validation."""
import hashlib
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from reference_prepare import export_seed

with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary)
    (root / 'bin').mkdir()
    for name in ['cppgm++.wasm', 'cppgm.wasm']:
        data=name.encode()
        (root / 'bin' / name).write_bytes(data)
        assert export_seed(root, {'binaries':{name:hashlib.sha256(data).hexdigest()}}).name == name
    try:
        export_seed(root, {'binaries':{'cppgm++.wasm':hashlib.sha256(b'cppgm++.wasm').hexdigest()}})
    except RuntimeError:
        pass
    else:
        raise AssertionError('a renamed seed with missing provenance fell back to another binary')
print('PASS: renamed and legacy compiler export names retain checksum checks')
