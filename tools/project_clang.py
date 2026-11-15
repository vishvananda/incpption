#!/usr/bin/env python3
"""Check the shared project recipes and runtime closure with native clang/LLD."""
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import json
import hashlib
from pathlib import Path
import subprocess
from project_prepare import archive_bytes
ROOT=Path(__file__).resolve().parents[1]

def check(project,jobs):
    manifest=json.loads((project/'manifest.json').read_text());inputs=project/'inputs';(project/'clang-logs').mkdir(exist_ok=True)
    script="import{clangCompileArgs,lldArgs}from'./web/clang_arguments.mjs';import fs from'node:fs';const m=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({commands:m.commands.map(r=>clangCompileArgs(r.args,r.language,m.source_date_epoch,m.id==='godot')),link:lldArgs(m.link.args)}));"
    normalized=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps(manifest).encode()))
    previous=json.loads((project/'clang-commands.json').read_text())if(project/'clang-commands.json').exists()else {}
    if not isinstance(previous,dict):previous={}
    source_hashes={row['path']:row['sha256']for row in manifest['files']}
    sources={row['source']for row in manifest['commands']}
    context=hashlib.sha256(json.dumps([(row['path'],row['sha256'])for row in manifest['files']if row['path']!='browser-imports.txt']).encode()).hexdigest()
    records=[None]*len(manifest['commands'])
    def mapped(value):return 'clang-'+value if value.startswith('build/')else value
    def one(index):
        row=manifest['commands'][index];args=[mapped(value)for value in normalized['commands'][index]]
        if row['language']=='assembler-with-cpp':args.append('-mbulk-memory')
        path=inputs/mapped(row['output']);old=previous.get('commands',[])[index]if index<len(previous.get('commands',[]))else {}
        record=dict(args=normalized['commands'][index],source_sha256=source_hashes[row['source']])
        if previous.get('context')==context and all(old.get(key)==value for key,value in record.items())and path.is_file()and hashlib.sha256(path.read_bytes()).hexdigest()==old.get('sha256'):
            records[index]=old;return
        (inputs/mapped(row['output'])).parent.mkdir(parents=True,exist_ok=True)
        result=subprocess.run(['clang++-22',*args],cwd=inputs,capture_output=True,timeout=600)
        (project/'clang-logs'/f'{index:05}.log').write_bytes(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError(row['source']+': '+result.stderr.decode()[-2500:])
        records[index]={**record,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    with ThreadPoolExecutor(max_workers=jobs)as pool:
        for count,future in enumerate(as_completed([pool.submit(one,index)for index in range(len(manifest['commands']))]),1):
            future.result()
            if count%200==0:print(project.name,'clang',count,flush=True)
    (project/'clang-commands.json').write_text(json.dumps(dict(context=context,commands=records)))
    for row in manifest['archives']:
        target=inputs/mapped(row['output']);target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(archive_bytes([dict(item,path=mapped(item['path']))for item in row['members']],inputs))
    args=[mapped(value)for value in normalized['link']]
    result=subprocess.run(['wasm-ld-22',*args],cwd=inputs,capture_output=True,timeout=600)
    (project/'clang-logs/link.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:print(result.stderr.decode()[-10000:],flush=True);raise RuntimeError(project.name+' clang runtime closure incomplete')
    print('clang compile/link passed:',project.name,flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--project',type=Path,required=True);p.add_argument('--jobs',type=int,default=8);a=p.parse_args();check(a.project.resolve(),a.jobs)
