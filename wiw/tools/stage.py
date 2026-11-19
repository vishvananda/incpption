#!/usr/bin/env python3
"""Stage the verified build inputs without copying SDKs into Git."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import re

from stage_binaryen import stage_binaryen

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'


def link(source, dest):
    source = source.resolve(strict=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_symlink():
        dest.unlink()
    dest.symlink_to(source, target_is_directory=source.is_dir())


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def compress(source, dest):
    with source.open('rb') as src, dest.open('wb') as out:
        with gzip.GzipFile(fileobj=out, mode='wb', filename='', mtime=0, compresslevel=6) as zipped:
            shutil.copyfileobj(src, zipped)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--incpption', type=Path, required=True, help='built incpption site with all three projects')
    parser.add_argument('--alpine', type=Path, required=True, help='staged configure/ directory with guest.json')
    parser.add_argument('--replay', type=Path, required=True, help='build-plan replay site with plans/manifest.json')
    parser.add_argument('--shared-root', action='store_true', help='share compiler and SDK URLs with incpption at the origin root')
    parser.add_argument('--wasi-probe', type=Path, help='static x86-64 Linux cppgm for Alpine WASI configure checks')
    parser.add_argument('--compiler', type=Path, help='fast cppgm WASI seed for the portable plan runner')
    parser.add_argument('--binaryen', type=Path, help='pinned Binaryen CMake build for browser Emscripten plans')
    parser.add_argument('--emscripten-plan', type=Path, action='append', default=[], help='stage a captured Emscripten plan')
    parser.add_argument('--registry', help='optional public HTTPS JSON plan index')
    args = parser.parse_args()
    site = args.incpption.resolve(strict=True)
    DIST.mkdir(exist_ok=True)
    shutil.copytree(ROOT / 'web', DIST, dirs_exist_ok=True)
    link(site / 'wasi_demo.css', DIST / 'wasi_demo.css')
    for name in ('projects', 'shim', 'vendor', 'clang-seed', 'licenses'):
        link(site / name, DIST / name)
    for source in (site / 'compiler').iterdir():
        if source.name != 'inputs':
            link(source, DIST / 'compiler' / source.name)
    seed = site / 'compiler/inputs/w1/cppgm.wasm'
    game_seed = DIST / 'compiler/inputs/w1/cppgm.wasm'
    game_seed.parent.mkdir(parents=True, exist_ok=True)
    compress(seed, game_seed)

    replay = args.replay / 'plans'
    profile = read(replay / 'manifest.json')
    alpine = DIST / 'alpine'
    shutil.copytree(ROOT / 'guest', alpine, dirs_exist_ok=True)
    for field in ('headers', 'cxxHeaders', 'link', 'cxxLink'):
        path = profile[field]['path']
        link(replay / path, alpine / path)
    if args.compiler:
        compress(args.compiler, alpine / 'cppgm.bin')
    else:
        shutil.copyfile(replay / 'cppgm.bin', alpine / 'cppgm.bin')
    data = (alpine / 'cppgm.bin').read_bytes()
    decoded = gzip.decompress(data) if data.startswith(b'\x1f\x8b') else data
    if not decoded.startswith(b'\x00asm'):
        raise ValueError('Expected a cppgm WebAssembly compiler')
    profile = {key: profile[key] for key in ('sdk', 'headers', 'cxxHeaders', 'link', 'cxxLink', 'includePaths')
               if key in profile}
    profile['compilerSha256'] = hashlib.sha256(decoded).hexdigest()
    if args.shared_root:
        profile['sharedAssets'] = '/'
        profile['wasiCompilerSha256'] = hashlib.sha256(seed.read_bytes()).hexdigest()
    probe_bytes = 0
    if args.wasi_probe:
        probe = args.wasi_probe.read_bytes()
        if not probe.startswith(b'\x7fELF\x02\x01') or probe[18:20] != b'\x3e\0':
            raise ValueError('Expected an x86-64 Linux executable for the WASI probe compiler')
        compress(args.wasi_probe, alpine / 'wasi-probe.bin')
        profile['wasiProbeSha256'] = hashlib.sha256(probe).hexdigest()
        probe_bytes = (alpine / 'wasi-probe.bin').stat().st_size
    write(alpine / 'profile.json', profile)
    guest = read(args.alpine / 'guest.json')
    link(args.alpine / 'guest.json', alpine / 'guest.json')
    for row in guest['chunks']:
        link(args.alpine / row['path'], alpine / row['path'])

    if args.binaryen:
        stage_binaryen(args.binaryen, DIST / 'binaryen')
    prepared = {}
    for directory in args.emscripten_plan:
        plan = read(directory / 'plan.json')
        if (plan['kind'] != 'emscripten' or not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', plan['repo']) or
                plan['repo'].split('/')[1] in ('.', '..') or not re.fullmatch(r'[a-f0-9]{40}', plan['commit'])):
            raise ValueError('Invalid Emscripten plan repository or revision')
        owner, repo = plan['repo'].split('/')
        destination = DIST / 'web-plans' / owner / repo / plan['commit']
        for filename in ('plan.json', *(plan[part]['path'] for part in ('source', 'libraries', 'player', 'sdkInputs'))):
            if not re.fullmatch(r'[A-Za-z0-9_-]+\.(?:bin|json)', filename):
                raise ValueError('Invalid Emscripten plan asset name: ' + filename)
            link(directory / filename, destination / filename)
        if plan['repo'].lower() == 'olzhasar/sdl-tetris':
            prepared['olzhasar/sdl-tetris'] = (destination / 'plan.json').relative_to(DIST).as_posix()
        print(f"Plan: /{(destination / 'plan.json').relative_to(DIST)}")

    transport = read(site / 'compiler/transport.json')
    sdk_files = [file for file in read(site / 'compiler/manifest.json')['files']
                 if file['path'].startswith(('sysroot/', 'resource/'))]
    wasi_sdk_bytes = sum((site / 'compiler' / part['path']).stat().st_size for part in transport['chunks']
                         if any(file['offset'] < part['offset'] + part['size'] and
                                part['offset'] < file['offset'] + file['size'] for file in sdk_files))
    metadata = read(site / 'site-release.json')
    write(DIST / 'settings.json', {
        'registry': args.registry,
        'sharedAssets': '/' if args.shared_root else '',
        'preparedPlans': prepared,
        'wasiProbeBytes': probe_bytes,
        'wasiSdkBytes': wasi_sdk_bytes,
        'guestBytes': sum((args.alpine / row['path']).stat().st_size for row in guest['chunks']),
        'compilerVersion': metadata['compiler_version'],
        'compilerBytes': len(data),
        'exampleCompilerBytes': game_seed.stat().st_size,
    })
    print(f'Staged {DIST}')


if __name__ == '__main__':
    main()
