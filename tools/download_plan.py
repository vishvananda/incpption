"""Cold download estimates from actual encoded static files, grouped by project."""
import json
from pathlib import Path

def prepare_download_plan(output):
    def package(directory,profile='all'):
        manifest=json.loads((output/directory/'manifest.json').read_text());transport=json.loads((output/directory/'transport.json').read_text())
        wanted=[r for r in manifest['files']if profile=='all'or not r['path'].startswith('x86/')]
        chunks=[r['path']for r in transport['chunks']if any(r['offset']<f['offset']+f['size'] and r['offset']+r['size']>f['offset']for f in wanted)]
        meta=['manifest.json','manifest.sha256','transport.json',*manifest.get('runner_files',{}),*manifest.get('shim_files',{})]
        meta+=[runtime['path']for runtime in manifest.get('runtime',{}).values()]
        return [directory+'/'+name for name in [*meta,*chunks]]
    seed=package('compiler','wasm');base=[name for name in seed if '/chunks/'not in name and not name.endswith('transport.json')]
    base+=['compiler/w1-complete.json','compiler/inputs/w1/cppgm.wasm']
    record=json.loads((output/'clang-seed/manifest.json').read_text());seeds=['clang-seed/manifest.json','clang-seed/manifest.sha256']
    for tool in record['tools'].values():seeds+=['clang-seed/'+row['path']for row in tool['chunks']]+['clang-seed/'+tool['runtime']['path']]
    references=[p.relative_to(output).as_posix()for p in(output/'compiler/inputs/w1').glob('*')if p.is_file()]
    runtime='llvm/'+json.loads((output/'llvm/manifest.json').read_text())['runtime']['clang']['path']
    stages=dict(match=sorted(set(base+seed+references)),llvm=sorted(set(base+package('llvm'))),clang=sorted(set(base+seed+[runtime])))
    targets=json.loads((Path(__file__).resolve().parents[1]/'config/projects.json').read_text())
    for key,target in targets.items():
        prefix='projects/'+key
        if not(output/prefix/'manifest.json').exists():target['available']=False;continue
        target['inputs']=sorted(set(package(prefix)))
        target['player']={**json.loads((output/prefix/'manifest.json').read_text())['player'],'baseURL':prefix+'/'}
        target['stages']={'game':sorted(set(base+package(prefix))),'game-clang':sorted(set(base+package(prefix)+seeds))}
        target['playFiles']=[p.relative_to(output).as_posix()for directory in ['player','assets']for p in(output/prefix/directory).rglob('*')if p.is_file()]
    names=set(name for group in stages.values()for name in group)
    for target in targets.values():
        names.update(target.get('playFiles',[]))
        for group in target.get('stages',{}).values():names.update(group)
    plan=dict(schema=1,setup={'cppgm':sorted(set(base)),'clang':sorted(set(base+seeds))},files={name:(output/name).stat().st_size for name in sorted(names)},stages=stages,targets=targets)
    (output/'download-plan.json').write_text(json.dumps(plan,separators=(',',':'))+'\n');return plan
