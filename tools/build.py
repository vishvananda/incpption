#!/usr/bin/env python3
"""Assemble site source around an immutable, hash-pinned compiler/game payload."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import html
import json
from pathlib import Path
import shutil
import subprocess

from inspector_vendor import prepare_vendor
from project_sources import prepare_sources,prepare_projects
from artifact_transport import logical_bytes
from download_plan import prepare_download_plan

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 25 * 1024 * 1024


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', type=Path, help='existing qualified static payload; never modified')
    parser.add_argument('--artifact-lock', type=Path, help='candidate artifact lock for local qualification')
    parser.add_argument('--seed-dir', type=Path, help='verified Clang seed package for local qualification')
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
    release = config['compiler_release']
    if manifest['revision'] != release['revision']:
        raise RuntimeError('Compiler payload does not match the displayed release')
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
    complete_projects=any(name.startswith('projects/')for name in entries)
    if complete_projects:
        for name in sorted(n for n in entries if n.startswith('projects/')):copy(name,output/name)
    else:
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
    seed_lock = json.loads((ROOT / 'config/clang-seed-lock.json').read_text()) if (ROOT / 'config/clang-seed-lock.json').is_file() else None
    seed_dir = args.seed_dir or ROOT / '.cache/clang-seed'
    if seed_lock and not args.seed_dir:
        for row in seed_lock['files']:
            target = seed_dir / row['path']
            if not target.is_file() or sha(target) != row['sha256']:
                target.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['curl', '-fsSL', '--retry', '3', '--max-time', '120', seed_lock['url'] + '/' + row['path'], '-o', str(target)], check=True)
            if sha(target) != row['sha256']: raise RuntimeError('Clang seed hash mismatch')
    if not seed_dir.is_dir(): raise RuntimeError('Clang seed package missing; see README')
    if seed_lock and not args.seed_dir:
        for row in seed_lock['files']:
            target=output/'clang-seed'/row['path'];target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(seed_dir/row['path'],target)
    else:
        shutil.copytree(seed_dir, output / 'clang-seed')
    seed_manifest = json.loads((output / 'clang-seed/manifest.json').read_text())
    llvm_manifest = json.loads((output / 'llvm/manifest.json').read_text())
    if seed_manifest['llvm_manifest_sha256'] != sha(output / 'llvm/manifest.json') or any(
            seed_manifest['tools'][name]['sha256'] != llvm_manifest[name]['sha256'] for name in ['clang', 'lld']):
        raise RuntimeError('Clang seed is from a different LLVM build')
    (output / 'clang-seed/manifest.sha256').write_text(sha(output / 'clang-seed/manifest.json') + '\n')
    prepare_download_plan(output)
    for path in (ROOT / 'web').rglob('*'):
        if path.is_file() and not path.name.startswith('.') and not path.name.endswith(('.template.html', '.swp', '.swo', '~')):
            target = output / path.relative_to(ROOT / 'web')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    subprocess.run(['node', str(ROOT / 'tools/render_report.mjs'), '--output', str(output / 'report.html')],
                   cwd=ROOT, check=True)
    # A cached shim from an older deployment can lack worker isolation headers.
    # Give the dependency graph a fresh URL without changing its pinned bytes.
    shim_identity = hashlib.sha256(json.dumps(manifest['shim_files'], sort_keys=True).encode() + (ROOT / 'config/_headers').read_bytes()).hexdigest()[:16]
    shim_directory = 'runtime-shim.' + shim_identity
    shutil.copytree(output / 'shim', output / shim_directory)
    runtime = output / 'wasi_runtime.mjs'
    runtime.write_text(runtime.read_text().replace("'./shim/index.js'", "'./" + shim_directory + "/index.js'"))
    # Pages gives CSS a four-hour browser cache lifetime. Give each version a
    # distinct URL so fresh HTML cannot pick up styling from an older release.
    project_index = prepare_projects(payload,output,json.loads((ROOT/'config/projects.json').read_text())) if complete_projects else prepare_sources(payload, output)
    styles = {}
    for path in sorted((ROOT / 'web').glob('*.css')):
        name = f'assets/{path.stem}.{sha(path)[:16]}.css'
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        styles[path.name] = name
    images = {}
    for original in ['share-logo.png', 'site-icon.png']:
        path = ROOT / 'web' / original
        name = f'assets/{path.stem}.{sha(path)[:16]}.png'
        shutil.copyfile(path, output / name)
        images[original] = f'https://{config["domain"]}/{name}'
    for path in output.glob('*.html'):
        content = path.read_text().replace('content="PROJECT_INDEX"', 'content="' + project_index + '"')
        content = content.replace('content="PLAYER_URL"', 'content="' + config['player_url'] + '"')
        for marker, value in [('SITE_DESCRIPTION', config['description']), ('PROJECT_PROMPT', config['project_prompt']), ('COMPILER_VERSION', release['version']), ('COMPILER_RELEASE_URL', release['url']), ('SHARE_IMAGE_URL', images['share-logo.png']), ('SITE_ICON_URL', images['site-icon.png'])]:
            content = content.replace(marker, html.escape(value, quote=True))
        for original, versioned in styles.items():
            content = content.replace(f'href="{original}"', f'href="{versioned}"')
        path.write_text(content)
    shutil.copyfile(output / 'wasi_demo.html', output / 'index.html')
    prepare_vendor(output / 'vendor')
    seed_loader = output / 'seed_package.mjs'
    seed_loader.write_text(seed_loader.read_text().replace("'@noble/hashes/sha2.js'", "'./vendor/noble/sha2.js'"))
    shutil.copyfile(ROOT / 'config/_headers', output / '_headers')
    credits = (payload / 'credits.html').read_text().replace('href="manifest.json"', 'href="compiler/manifest.json"')
    credits = credits.replace('href="openlara/manifest.json"', 'href="game/manifest.json"')
    if (output / 'llvm/manifest.json').is_file():
        credits = credits.replace('</main>', '<h2>Optional clang round trip</h2>'
            '<p>clang 22.1.2 and its LLVM libraries are built here from C/C++ source, including Clang and LLD. '
            'The browser profile supplies generated headers, SDK libraries and Emscripten glue. '
            'Source adaptations use the Emscripten stack API, disable process crash recovery, '
            'flatten MSP430 StringSwitch chains, and split long generated ARM case-label chains. '
            '<a href="llvm/manifest.json">clang inputs and source hashes</a> · '
            '<a href="licenses/llvm/llvm-LICENSE.TXT">LLVM license and exceptions</a> · '
            '<a href="licenses/llvm/clang-LICENSE.TXT">Clang license</a> · '
            '<a href="licenses/llvm/lld-LICENSE.TXT">LLD license</a>.</p></main>')
    (output / 'licenses/site').mkdir(parents=True, exist_ok=True)
    for name in ['LICENSE', 'NOTICE']:
        shutil.copyfile(ROOT / name, output / 'licenses/site' / name)
    shutil.copyfile(ROOT / 'third_party/octicons-LICENSE', output / 'licenses/site/octicons-LICENSE')
    shutil.copyfile(ROOT / 'third_party/emscripten-LICENSE', output / 'licenses/site/emscripten-LICENSE')
    credits = credits.replace('</main>', '<h2>Site source</h2><p><a href="https://github.com/vishvananda/incpption">cppgm inception</a> is Apache-2.0. <a href="licenses/site/NOTICE">Notices</a>. GitHub mark: <a href="licenses/site/octicons-LICENSE">Octicons MIT license</a>.</p></main>')
    for original, versioned in styles.items():
        credits = credits.replace(f'href="{original}"', f'href="{versioned}"')
    (output / 'credits.html').write_text(credits)
    revision_result = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT,
                                     capture_output=True, text=True)
    revision = revision_result.stdout.strip() if revision_result.returncode == 0 else 'uncommitted'
    (output / 'site-release.json').write_text(json.dumps(dict(site=config['name'], domain=config['domain'],
        git_revision=revision, compiler_version=release['version'], compiler_revision=manifest['revision'], artifact_url=lock['url'], artifact_lock_sha256=sha(lock_path),
        compiler_manifest_sha256=sha(payload / 'manifest.json'), compiler_sha256=seed['commands'][-1]['sha256']), indent=2) + '\n')
    files = [p for p in output.rglob('*') if p.is_file()]
    if len(files) > 20000 or any(p.stat().st_size > LIMIT for p in files):
        raise RuntimeError('Cloudflare Pages asset limits exceeded')
    print(f'Built {len(files)} files in {output}; compiler {seed["commands"][-1]["sha256"]}')


if __name__ == '__main__':
    main()
