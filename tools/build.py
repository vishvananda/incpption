#!/usr/bin/env python3
"""Assemble site source around an immutable, hash-pinned compiler/game payload."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from inspector_vendor import prepare_vendor
from project_sources import prepare_sources
from artifact_transport import logical_bytes

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 25 * 1024 * 1024


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', type=Path, help='existing qualified static payload; never modified')
    parser.add_argument('--artifact-lock', type=Path, help='candidate artifact lock for local qualification')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    config = json.loads((ROOT / 'site.json').read_text())
    lock_path = args.artifact_lock or ROOT / config['artifact_lock']
    lock = json.loads(lock_path.read_text())
    entries = {r['path']: r for r in lock['files'] if r['path'] != '_headers'}
    payload = args.artifact_dir or ROOT / '.cache' / sha(lock_path)
    payload = payload.resolve()
    if not args.artifact_dir:
        payload.mkdir(parents=True, exist_ok=True)
    def ensure(row):
        relative = Path(row['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('invalid artifact path')
        target = payload / relative
        if target.is_file() and sha(target) == row['sha256']:
            return
        if args.artifact_dir:
            raise RuntimeError('artifact changed or missing: ' + str(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.download')
        subprocess.run(['curl', '-fsSL', '--retry', '3', '--max-time', '120',
                        lock['url'] + '/' + row['path'], '-o', str(temporary)], check=True)
        if sha(temporary) != row['sha256']:
            raise RuntimeError('download hash mismatch: ' + row['path'])
        temporary.replace(target)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(ensure, entries.values()))
    output = args.output.resolve()
    if output.exists():
        if not args.force or output not in [ROOT / 'dist', ROOT / 'build']:
            raise RuntimeError('use a new output directory or --force for dist/build')
        shutil.rmtree(output)
    output.mkdir(parents=True)
    # Original compiler and game manifests remain byte-identical. Website UI
    # updates have their own Git revision and never rebind compiler provenance.
    manifest = json.loads((payload / 'manifest.json').read_text())
    seed = json.loads((payload / 'w1-complete.json').read_text())
    names = set(manifest['runner_files']) | set(manifest['shim_files'])
    names |= {'manifest.json', 'manifest.sha256', 'bundle.bin', 'w1-complete.json'}
    transport_path = payload / 'transport.json'
    if transport_path.is_file():
        transport = json.loads(transport_path.read_text())
        names.discard('bundle.bin')
        names |= {'transport.json', *[row['path'] for row in transport['chunks']]}
    names |= {'inputs/' + r['output'] for r in seed['commands']}
    names |= {f'inputs/x86-check/checks__floating.cpp.o.O{level}.native.o' for level in [0, 2]}
    def copy(name, target):
        if name not in entries:
            raise RuntimeError('artifact is not pinned: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(payload / name, target)
    for name in sorted(names):
        copy(name, output / 'compiler' / name)
    if not transport_path.is_file():
        transport = dict(schema=1, bytes=len(logical_bytes(payload / 'bundle.bin')),
            sha256=manifest['bundle_sha256'], chunks=[dict(path='bundle.bin', offset=0,
                size=len(logical_bytes(payload / 'bundle.bin')), sha256=manifest['bundle_sha256'])])
        (output / 'compiler/transport.json').write_text(json.dumps(transport) + '\n')
    for name in sorted(n for n in entries if n.startswith('openlara/')):
        copy(name, output / 'game' / name.removeprefix('openlara/'))
    if not (output / 'game/transport.json').is_file():
        game_manifest = json.loads((payload / 'openlara/manifest.json').read_text())
        size = len(logical_bytes(payload / 'openlara/bundle.bin'))
        transport = dict(schema=1, bytes=size, sha256=game_manifest['bundle_sha256'],
            chunks=[dict(path='bundle.bin', offset=0, size=size, sha256=game_manifest['bundle_sha256'])])
        (output / 'game/transport.json').write_text(json.dumps(transport) + '\n')
    for name in sorted(n for n in entries if n.startswith(('licenses/', 'shim/', 'llvm/'))):
        copy(name, output / name)
    for path in (ROOT / 'web').rglob('*'):
        if path.is_file():
            target = output / path.relative_to(ROOT / 'web')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    # Pages gives CSS a four-hour browser cache lifetime. Give each version a
    # distinct URL so fresh HTML cannot pick up styling from an older release.
    project_index = prepare_sources(payload, output)
    styles = {}
    for path in sorted((ROOT / 'web').glob('*.css')):
        name = f'assets/{path.stem}.{sha(path)[:16]}.css'
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        styles[path.name] = name
    for path in output.glob('*.html'):
        content = path.read_text().replace('content="PROJECT_INDEX"', 'content="' + project_index + '"')
        for original, versioned in styles.items():
            content = content.replace(f'href="{original}"', f'href="{versioned}"')
        path.write_text(content)
    shutil.copyfile(output / 'wasi_demo.html', output / 'index.html')
    prepare_vendor(output / 'vendor')
    shutil.copyfile(ROOT / 'config/_headers', output / '_headers')
    credits = (payload / 'credits.html').read_text().replace('href="manifest.json"', 'href="compiler/manifest.json"')
    credits = credits.replace('href="openlara/manifest.json"', 'href="game/manifest.json"')
    if (output / 'llvm/manifest.json').is_file():
        credits = credits.replace('</main>', '<h2>Optional LLVM roundtrip</h2>'
            '<p>LLVM 22.1.2 is built here from C/C++ source, including Clang and LLD. '
            'The browser profile supplies generated headers, SDK libraries and Emscripten glue. '
            'Source adaptations use the Emscripten stack API, disable process crash recovery, '
            'flatten MSP430 StringSwitch chains, and split long generated ARM case-label chains. '
            '<a href="llvm/manifest.json">LLVM inputs and source hashes</a> · '
            '<a href="licenses/llvm/llvm-LICENSE.TXT">LLVM license and exceptions</a> · '
            '<a href="licenses/llvm/clang-LICENSE.TXT">Clang license</a> · '
            '<a href="licenses/llvm/lld-LICENSE.TXT">LLD license</a>.</p></main>')
    for original, versioned in styles.items():
        credits = credits.replace(f'href="{original}"', f'href="{versioned}"')
    (output / 'credits.html').write_text(credits)
    revision_result = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT,
                                     capture_output=True, text=True)
    revision = revision_result.stdout.strip() if revision_result.returncode == 0 else 'uncommitted'
    (output / 'site-release.json').write_text(json.dumps(dict(site=config['name'], domain=config['domain'],
        git_revision=revision, artifact_url=lock['url'], artifact_lock_sha256=sha(lock_path),
        compiler_manifest_sha256=sha(payload / 'manifest.json'), compiler_sha256=seed['commands'][-1]['sha256']), indent=2) + '\n')
    files = [p for p in output.rglob('*') if p.is_file()]
    if len(files) > 20000 or any(p.stat().st_size > LIMIT for p in files):
        raise RuntimeError('Cloudflare Pages asset limits exceeded')
    print(f'Built {len(files)} files in {output}; compiler {seed["commands"][-1]["sha256"]}')


if __name__ == '__main__':
    main()
