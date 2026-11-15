#!/usr/bin/env python3
"""Package verified Clang and LLD binaries as hash-checked static chunks."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(llvm, binaries, output):
    manifest = json.loads((llvm / 'manifest.json').read_text())
    output.mkdir(parents=True)
    shutil.copyfile(Path(__file__).resolve().parents[1] / 'third_party/llvm-LICENSE.txt', output / 'LICENSE')
    (output / 'NOTICE').write_text('Clang and LLD, LLVM ' + manifest['revision'] + '.\nBuilt by cppgm; source profile and binary hashes are in manifest.json and the site LLVM manifest.\nSource: https://github.com/llvm/llvm-project\nJavaScript host and C runtime: Emscripten and musl; see licenses/.\n')
    source_licenses = llvm.parent / 'licenses'
    for name in ['emscripten-LICENSE.txt', 'emscripten-AUTHORS.txt', 'emscripten-system-lib-libc-musl-COPYRIGHT.txt']:
        if (source_licenses / name).is_file():
            (output / 'licenses').mkdir(exist_ok=True)
            shutil.copyfile(source_licenses / name, output / 'licenses' / name)
    tools = {}
    for name, filename in [('clang', 'clang-lld.wasm'), ('lld', 'lld.wasm')]:
        data = (binaries / filename).read_bytes()
        if digest(data) != manifest[name]['sha256']:
            raise ValueError(name + ' does not match the qualified LLVM build')
        chunks = []
        for index, start in enumerate(range(0, len(data), 16 * 1024 * 1024)):
            part = data[start:start + 16 * 1024 * 1024]
            encoded = gzip.compress(part, compresslevel=6, mtime=0)
            path = f'{name}.{index:02}.bin'
            (output / path).write_bytes(encoded)
            chunks.append(dict(path=path, size=len(part), encoded_bytes=len(encoded), sha256=digest(part)))
        runtime = manifest['runtime'][name]
        shutil.copyfile(llvm / runtime['path'], output / runtime['path'])
        tools[name] = dict(bytes=len(data), sha256=digest(data), chunks=chunks, runtime=runtime)
    record = dict(schema=1, revision=manifest['revision'], llvm_manifest_sha256=digest((llvm / 'manifest.json').read_bytes()), tools=tools)
    (output / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--llvm', required=True, type=Path)
    parser.add_argument('--binaries', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.llvm, args.binaries, args.output)
