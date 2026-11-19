"""Stage the browser build of the Binaryen tools used by Emscripten 4.0.9."""
import gzip
import hashlib
import json
from pathlib import Path
import shutil

TOOLS = ('wasm-opt', 'wasm-metadce', 'wasm-emscripten-finalize')


def stage_binaryen(build, output):
    output.mkdir(parents=True, exist_ok=True)
    tools = {}
    for name in TOOLS:
        runtime = (build / 'bin' / (name + '.js')).read_bytes()
        binary = (build / 'bin' / (name + '.wasm')).read_bytes()
        if b'export default' not in runtime or not binary.startswith(b'\0asm'):
            raise ValueError('Expected a modularized browser Binaryen build: ' + name)
        (output / (name + '.mjs')).write_bytes(runtime)
        (output / (name + '.wasm')).write_bytes(gzip.compress(binary, mtime=0, compresslevel=6))
        tools[name] = {'sha256': hashlib.sha256(binary).hexdigest(),
                       'runtimeSha256': hashlib.sha256(runtime).hexdigest()}
    source = next(line.split('=', 1)[1] for line in (build / 'CMakeCache.txt').read_text().splitlines()
                  if line.startswith('CMAKE_HOME_DIRECTORY:INTERNAL='))
    shutil.copyfile(Path(source) / 'LICENSE', output / 'LICENSE.txt')
    (output / 'manifest.json').write_text(json.dumps({'tools': tools}, indent=2) + '\n')
