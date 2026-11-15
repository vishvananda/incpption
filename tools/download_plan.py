"""Publish cold download estimates from the actual encoded static files."""
import json
from pathlib import Path


def prepare_download_plan(output: Path):
    def seeds():
        record = json.loads((output / 'clang-seed/manifest.json').read_text())
        names = ['manifest.json', 'manifest.sha256']
        for tool in record['tools'].values():
            names += [row['path'] for row in tool['chunks']] + [tool['runtime']['path']]
        return ['clang-seed/' + name for name in names]

    def package(directory, profile='all'):
        manifest = json.loads((output / directory / 'manifest.json').read_text())
        transport = json.loads((output / directory / 'transport.json').read_text())
        wanted = [r for r in manifest['files'] if profile == 'all' or not r['path'].startswith('x86/')]
        chunks = [r['path'] for r in transport['chunks'] if any(r['offset'] <= f['offset'] < r['offset'] + r['size'] for f in wanted)]
        meta = ['manifest.json', 'manifest.sha256', 'transport.json']
        meta += list(manifest.get('runner_files', {})) + list(manifest.get('shim_files', {}))
        meta += [runtime['path'] for runtime in manifest.get('runtime', {}).values()]
        return [directory + '/' + name for name in [*meta, *chunks]]

    seed = package('compiler', 'wasm')
    base = [name for name in seed if '/chunks/' not in name and not name.endswith('transport.json')]
    base += ['compiler/w1-complete.json', 'compiler/inputs/w1/cppgm.wasm']
    game = package('game')
    references = [p.relative_to(output).as_posix() for p in (output / 'compiler/inputs/w1').glob('*') if p.is_file()]
    clang_runtime = 'llvm/' + json.loads((output / 'llvm/manifest.json').read_text())['runtime']['clang']['path']
    stages = dict(match=sorted(set(base + seed + references)), llvm=sorted(set(base + package('llvm'))),
                  clang=sorted(set(base + seed + [clang_runtime])), game=sorted(set(base + game)),
                  **{'game-clang': sorted(set(base + game + seeds()))})
    sizes = {name: (output / name).stat().st_size for names in stages.values() for name in names}
    targets = json.loads((Path(__file__).resolve().parents[1] / 'config/projects.json').read_text())
    plan = dict(schema=1, files=sizes, stages=stages, targets=targets)
    (output / 'download-plan.json').write_text(json.dumps(plan, separators=(',', ':')) + '\n')
    return plan
