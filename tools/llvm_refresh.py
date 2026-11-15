#!/usr/bin/env python3
"""Requalify the frozen clang source profile with a new published cppgm seed."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from artifact_transport import logical_bytes, publish_bundle
from project_prepare import archive_bytes

def sha(data):return hashlib.sha256(data).hexdigest()
def save(path,value):path.write_text(json.dumps(value,indent=2)+'\n')

def main(args):
    old=json.loads((args.template/'manifest.json').read_text());out=args.output;out.mkdir(parents=True)
    inputs=out/'inputs';inputs.mkdir();bundle=logical_bytes(args.template/'bundle.bin')
    for row in old['files']:
        data=bundle[row['offset']:row['offset']+row['size']]
        if sha(data)!=row['sha256']:raise ValueError('frozen clang input changed')
        path=inputs/row['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    del bundle
    compiler=(args.compiler_reference/'native-compiler').resolve();manifest=json.loads((args.compiler_reference/'manifest.json').read_text());commands=[]
    (out/'logs').mkdir();start=time.monotonic()
    def compile_one(index):
        command=dict(old['commands'][index]);path=inputs/command['output'];path.parent.mkdir(parents=True,exist_ok=True)
        result=subprocess.run([str(compiler),*command['args']],cwd=inputs,capture_output=True,timeout=1200)
        (out/'logs'/f'{index:05}.log').write_bytes(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError(command['source']+': '+result.stderr.decode(errors='replace')[-2000:])
        command['sha256']=sha(path.read_bytes());return index,command
    commands=[None]*len(old['commands'])
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures=[pool.submit(compile_one,index) for index in range(len(commands))]
        for count,future in enumerate(as_completed(futures),1):
            index,command=future.result();commands[index]=command
            if count%100==0:print('clang native',count,'/',len(commands),flush=True)
    for row in old['archives']:
        path=inputs/row['output'];path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(archive_bytes([dict(name=Path(member).name,path=member)for member in row['members']],inputs))
    (inputs/'bin').mkdir(exist_ok=True)
    result=subprocess.run([str(compiler),*old['lld']['args']],cwd=inputs,capture_output=True,timeout=1200)
    (out/'logs/lld.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError(result.stderr.decode()[-2500:])
    result=subprocess.run(['wasm-ld-22',*old['clang']['args']],cwd=inputs,capture_output=True,timeout=1200)
    (out/'logs/clang.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError(result.stderr.decode()[-2500:])
    updated={**old,'cppgm_revision':manifest['revision'],'compiler_manifest':sha((args.compiler_reference/'manifest.json').read_bytes()),'commands':commands,
             'lld':{**old['lld'],'sha256':sha((inputs/'bin/lld.wasm').read_bytes())},'clang':{**old['clang'],'sha256':sha((inputs/'bin/clang-lld.wasm').read_bytes())}}
    save(out/'native-complete.json',dict(seconds=time.monotonic()-start,objects=len(commands)))
    save(out/'manifest.json',updated);(out/'manifest.sha256').write_text(sha((out/'manifest.json').read_bytes())+'\n')
    for runtime in old['runtime'].values():shutil.copyfile(args.template/runtime['path'],out/runtime['path'])
    # Filesystem inputs remain identical; executable/object bytes are deliberately absent.
    shutil.copytree(args.template/'chunks',out/'chunks');shutil.copyfile(args.template/'transport.json',out/'transport.json')
    compiled=(args.compiler_reference/'qualified-seed.cwasm').resolve();runner=[str(args.wasmtime),'run','--allow-precompiled','-W','exceptions=y','-W','max-wasm-stack=8388608','--dir',str(inputs.resolve())+'::.',str(compiled)]
    def verify_one(index):
        command=commands[index];args_out=[]
        for value in command['args']:args_out.append('wasi-'+value if value==command['output'] else value)
        (inputs/('wasi-'+command['output'])).parent.mkdir(parents=True,exist_ok=True)
        result=subprocess.run([*runner,*args_out],cwd=inputs,capture_output=True,timeout=1200)
        if result.returncode:raise RuntimeError(command['source']+': '+result.stderr.decode()[-2000:])
        if sha((inputs/('wasi-'+command['output'])).read_bytes())!=command['sha256']:raise ValueError('native/WASI clang object mismatch: '+command['source'])
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for count,future in enumerate(as_completed([pool.submit(verify_one,index)for index in range(len(commands))]),1):
            future.result()
            if count%100==0:print('clang WASI',count,'/',len(commands),flush=True)
    save(out/'wasi-complete.json',dict(objects=len(commands),matched=True))
    print('clang native/WASI qualification complete',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['template','compiler-reference','output','wasmtime']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--jobs',type=int,default=8);main(parser.parse_args())
