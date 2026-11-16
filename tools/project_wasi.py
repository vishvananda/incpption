#!/usr/bin/env python3
"""Qualify project reference bytes with the actual shipped WASI compiler."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from project_prepare import archive_bytes

def sha(data): return hashlib.sha256(data).hexdigest()
def save(path,value): path.write_text(json.dumps(value,indent=2)+'\n')
def qualify(project,reference,wasmtime,jobs):
    manifest=json.loads((project/'manifest.json').read_text());inputs=project/'inputs';logs=project/'wasi-logs';logs.mkdir(exist_ok=True)
    environment=os.environ.copy()
    if 'source_date_epoch'in manifest:
        environment.update(LD_PRELOAD=str((project/'frozen-time.so').resolve()),TZ='UTC')
    runner=[str(wasmtime),'run','--allow-precompiled','-W','exceptions=y','-W','max-wasm-stack=8388608','--dir',str(inputs.resolve())+'::.',str((reference/'qualified-seed.cwasm').resolve())]
    cache=project/'wasi-commands.json';previous=json.loads(cache.read_text())if cache.exists()else []
    records=[None]*len(manifest['commands'])
    source_hashes={row['path']:row['sha256']for row in manifest['files']}
    sources={row['source']for row in manifest['commands']}
    context=sha(json.dumps([(row['path'],row['sha256'])for row in manifest['files']if row['path']!='browser-imports.txt']).encode())
    seed_sha=sha((reference/'inputs/w1/cppgm.wasm').read_bytes())
    def one(index):
        row=manifest['commands'][index];args=[('wasi-'+arg if arg==row['output']else arg)for arg in row['args']];path=inputs/('wasi-'+row['output']);path.parent.mkdir(parents=True,exist_ok=True)
        proof=logs/f'{index:05}.json';old=json.loads(proof.read_text())if proof.exists()else {}
        identity=dict(args=args,source_sha256=source_hashes[row['source']],context=context,seed_sha256=seed_sha)
        if any(old.get(key)!=value for key,value in identity.items())or not path.exists()or sha(path.read_bytes())!=old.get('sha256'):
            result=subprocess.run([*runner,*args],cwd=inputs,capture_output=True,timeout=1200,env=environment)
            (logs/f'{index:05}.log').write_bytes(result.stdout+result.stderr)
            if result.returncode:raise RuntimeError(row['source']+': '+result.stderr.decode()[-2000:])
        checksum=sha(path.read_bytes());records[index]={**identity,'sha256':checksum};save(proof,records[index])
        return index,checksum
    differences=[]
    with ThreadPoolExecutor(max_workers=jobs)as pool:
        futures=[pool.submit(one,index)for index in range(len(manifest['commands']))]
        for count,future in enumerate(as_completed(futures),1):
            try:index,checksum=future.result()
            except Exception:
                for pending in futures:pending.cancel()
                raise
            row=manifest['commands'][index]
            row.setdefault('native_sha256',row['sha256'])
            if checksum!=row['native_sha256']:differences.append(row['source'])
            row['sha256']=checksum
            if count%200==0:print(project.name,'WASI',count,flush=True)
    save(cache,records)
    # Archive and link the same WASI-generated objects the browser will build.
    for row in manifest['commands']:shutil.copyfile(inputs/('wasi-'+row['output']),inputs/row['output'])
    for row in manifest['archives']:
        data=archive_bytes(row['members'],inputs);(inputs/row['output']).write_bytes(data);row['sha256']=sha(data)
    # Preview2-backed Wasmtime can reject the editor's large fwrite. The
    # browser adapter accepts the same write, so use it for reference linking.
    runtime=project/'qualification-host';runtime.mkdir(exist_ok=True)
    site=Path(__file__).resolve().parents[1]
    for name in ['wasi_runtime.mjs','file_buffers.mjs','transport_bytes.mjs','bundle_layers.mjs','error_text.mjs','wasi_process.mjs']:
        shutil.copyfile(site/'web'/name,runtime/name)
    shutil.copytree(reference/'shim',runtime/'shim',dirs_exist_ok=True)
    save(runtime/'package.json',{'type':'module'})
    result=subprocess.run(['node',str(site/'tools/wasi_link.mjs'),str(project),str(reference),str(runtime)],capture_output=True,timeout=1200)
    (logs/'link.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError(result.stderr.decode()[-3000:])
    manifest['link'].setdefault('native_sha256',manifest['link']['sha256']);manifest['link']['sha256']=sha((inputs/manifest['link']['output']).read_bytes())
    manifest['reference_runtime']='wasi'
    save(project/'wasi-complete.json',dict(objects=len(records),native_differences=differences,seed_sha256=sha((reference/'inputs/w1/cppgm.wasm').read_bytes())))
    save(project/'manifest.json',manifest);(project/'manifest.sha256').write_text(sha((project/'manifest.json').read_bytes())+'\n')
    print('Qualified shipped-WASI reference:',project.name,len(records),'objects;',len(differences),'native differences',flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['project','reference','wasmtime']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--jobs',type=int,default=8);a=p.parse_args();qualify(a.project.resolve(),a.reference.resolve(),a.wasmtime.resolve(),a.jobs)
