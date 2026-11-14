#!/usr/bin/env python3
"""Package a frozen, independently verified LLVM browser build without its objects."""
import argparse
import hashlib
import json
from pathlib import Path
from artifact_transport import publish_bundle


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(build, compiler, runtimes, output):
    plan = json.loads((build / 'build-plan.json').read_text())
    native = json.loads((build / 'native-objects.json').read_text())
    wasi = json.loads((build / 'wasi-complete.json').read_text())
    expected = {row['source']: row['sha256'] for row in native['objects']}
    actual = {row['source']: row['sha256'] for row in wasi['objects']}
    if actual != expected or len(expected) != len(plan['commands']):
        raise RuntimeError('LLVM native/WASI object qualification is incomplete')
    generated = {row['output'] for row in plan['archives']}
    inputs = build / 'inputs'
    output.mkdir(parents=True, exist_ok=False)
    raw = output / 'bundle.bin'
    files = []
    with raw.open('wb') as stream:
        for path in sorted(inputs.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(inputs).as_posix()
            # Frozen sources/generated headers and the SDK are inputs. LLVM
            # objects, archives, executables and logs must be built in-browser.
            if relative in generated or relative.split('/')[0] in {'obj', 'wasi-obj', 'bin'} or path.suffix == '.log':
                continue
            data = path.read_bytes()
            files.append(dict(path=relative, offset=stream.tell(), size=len(data), sha256=digest(data)))
            stream.write(data)
    runtime = {}
    for name in ['clang', 'lld']:
        data = (runtimes / (name + '-own.mjs')).read_bytes()
        target = f'{name}.{digest(data)[:16]}.mjs'
        (output / target).write_bytes(data)
        runtime[name] = dict(path=target, sha256=digest(data))
    manifest = dict(schema=1, revision=plan['revision'], cppgm_revision=plan['cppgm_revision'],
        overlays=plan.get('overlays', {}),
        compiler_manifest=digest((compiler / 'manifest.json').read_bytes()),
        bundle_sha256=digest(raw.read_bytes()), files=files, runtime=runtime,
        commands=[{k: v for k, v in row.items() if k != 'original_output'} | {'sha256': expected[row['source']]}
                  for row in plan['commands']], archives=plan['archives'],
        lld=dict(args=[*plan['links']['lld']['flags'], *plan['links']['lld']['files'], '-o', 'bin/lld.wasm'],
                 sha256=digest((inputs / 'bin/lld.wasm').read_bytes())),
        clang=dict(args=json.loads((build / 'clang-lld-flags.json').read_text()),
                   sha256=digest((inputs / 'bin/clang-lld.wasm').read_bytes())))
    data = (json.dumps(manifest, indent=2) + '\n').encode()
    (output / 'manifest.json').write_bytes(data)
    (output / 'manifest.sha256').write_text(digest(data) + '\n')
    publish_bundle(raw, output, manifest)
    raw.unlink()
    print(f'Packaged {len(files)} frozen inputs; {len(expected)} objects must be built locally')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['build', 'compiler', 'runtimes', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    prepare(args.build, args.compiler, args.runtimes, args.output)
