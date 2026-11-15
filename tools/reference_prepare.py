#!/usr/bin/env python3
"""Qualify a browser compiler payload from the published WASI reference export."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def export_seed(source, provenance):
    # Published exports retain their original names and provenance keys.
    name = next((name for name in ['cppgm.wasm', 'cppgm++.wasm'] if (source / 'bin' / name).is_file()), None)
    if not name or digest(source / 'bin' / name) != provenance['binaries'].get(name):
        raise RuntimeError('release compiler checksum differs')
    return source / 'bin' / name


def prepare(args):
    source = args.export.resolve()
    output = args.output.resolve()
    output.mkdir()
    inputs = output / 'inputs'
    manifest = json.loads((source / 'manifest.json').read_text())
    if digest(source / 'manifest.json') != (source / 'manifest.sha256').read_text().strip():
        raise RuntimeError('release manifest checksum differs')
    if digest(source / 'bundle.bin') != manifest['bundle_sha256']:
        raise RuntimeError('release filesystem checksum differs')
    provenance = json.loads((source / 'wasm-reference-provenance.json').read_text())
    seed = export_seed(source, provenance)
    subprocess.run(['python3', str(source / 'unpack_wasi_inputs.py'), str(source), str(inputs)], check=True)
    for name in ['manifest.json', 'manifest.sha256', 'bundle.bin', 'wasm-reference-provenance.json']:
        shutil.copyfile(source / name, output / name)
    for name, expected in manifest['runner_files'].items():
        original = args.cppgm_root / 'scripts/experimental' / name
        if digest(original) != expected:
            raise RuntimeError('runner does not match release: ' + name)
        shutil.copyfile(original, output / name)
    shutil.copytree(args.shim / 'dist', output / 'shim')
    for name in ['package.json', 'LICENSE-MIT', 'LICENSE-APACHE']:
        shutil.copyfile(args.shim / name, output / 'shim' / name)
    for name, expected in manifest['shim_files'].items():
        if digest(output / name) != expected:
            raise RuntimeError('WASI adapter does not match release: ' + name)
    shutil.copyfile(args.compiler, output / 'native-compiler')
    (output / 'native-compiler').chmod(0o755)
    stage = inputs / 'w1'
    stage.mkdir()
    started = time.monotonic()

    def run(arguments, name):
        target = inputs / name
        before = time.monotonic()
        with Path(str(target) + '.log').open('wb') as log:
            command = [str(output / 'native-compiler'), *manifest['flags'], *arguments, '-o', name]
            subprocess.run(command, cwd=inputs, stdout=log, stderr=log, check=True)
        return dict(command=command, output=name, exit=0, seconds=time.monotonic()-before,
                    bytes=target.stat().st_size, sha256=digest(target))

    def compile(source):
        return run(['-c', source], 'w1/' + source.replace('/', '__') + '.o')

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        rows = list(pool.map(compile, manifest['sources']))
    rows.append(run([*[row['output'] for row in rows], *manifest['link_flags']], 'w1/cppgm.wasm'))
    if (stage / 'cppgm.wasm').read_bytes() != seed.read_bytes():
        raise RuntimeError('native reference build does not reproduce the published compiler')
    # Serve the release's actual seed; the local result established exact equality.
    shutil.copyfile(seed, stage / 'cppgm.wasm')
    save(output / 'w1-complete.json', dict(stage=1, manifest=digest(output / 'manifest.json'), seconds=time.monotonic()-started,
                                         runtime='published WASI export; independently reproduced', commands=rows))
    save(output / 'release-origin.json', dict(revision=manifest['revision'], compiler_sha256=digest(seed),
        provenance_sha256=digest(source / 'wasm-reference-provenance.json'),
        qualification_compiler_sha256=digest(args.compiler), reproduced=True))
    (inputs / 'x86-check').mkdir()
    for level in [0, 2]:
        flags = [*manifest['x86_flags'], '-O' + str(level), '-c', 'checks/floating.cpp']
        name = 'x86-check/checks__floating.cpp.o.O' + str(level)
        subprocess.run([str(output / 'native-compiler'), *flags, '-o', name + '.native.o'],
                       cwd=inputs, check=True)
        subprocess.run([str(args.wasmtime), 'run', '-W', 'exceptions=y', '-W',
                        'max-wasm-stack=8388608', '--dir', str(inputs) + '::.', str(seed),
                        *flags, '-o', name + '.wasi.o'], cwd=inputs, check=True)
        if (inputs / (name + '.native.o')).read_bytes() != (inputs / (name + '.wasi.o')).read_bytes():
            raise RuntimeError('published compiler differs on x86 floating-point output')
    # Keep the existing source, SDK, runtime glue and build date. Rebuild all game
    # outputs with this compiler so the game's reference bytes match the new seed.
    game = output / 'openlara'
    shutil.copytree(args.game_template, game)
    game_manifest = json.loads((game / 'manifest.json').read_text())
    for row in game_manifest['commands']:
        arguments = ['native/' + arg.removeprefix('build/') if arg.startswith('build/')
                     else arg for arg in row['args']]
        arguments[arguments.index('-o') + 1] = row['expected']
        with (game / (Path(row['expected']).name + '.qualification.log')).open('wb') as log:
            subprocess.run([str(output / 'native-compiler'), *arguments], cwd=game / 'inputs',
                           stdout=log, stderr=log, check=True)
    files = []
    with (game / 'bundle.bin').open('wb') as bundle:
        for path in sorted((game / 'inputs').rglob('*')):
            relative = path.relative_to(game / 'inputs')
            if not path.is_file() or relative.parts[0] == 'build':
                continue
            data = path.read_bytes()
            files.append(dict(path=str(relative), offset=bundle.tell(), size=len(data),
                              sha256=hashlib.sha256(data).hexdigest()))
            bundle.write(data)
    game_manifest.update(compiler_manifest=digest(output / 'manifest.json'), files=files,
                         bundle_sha256=digest(game / 'bundle.bin'))
    save(game / 'manifest.json', game_manifest)
    (game / 'manifest.sha256').write_text(digest(game / 'manifest.json') + '\n')
    # Published notices cover the compiler SDK; preserve the separate game's notices.
    shutil.copytree(args.credits_template / 'licenses', output / 'licenses')
    shutil.copytree(source / 'licenses', output / 'licenses' / 'reference-export')
    shutil.copyfile(args.credits_template / 'credits.html', output / 'credits.html')
    print('Published compiler reproduced; game reference outputs rebuilt:', output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['export', 'output', 'compiler', 'cppgm-root', 'shim', 'game-template', 'credits-template', 'wasmtime']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=8)
    prepare(parser.parse_args())


if __name__ == '__main__':
    main()
