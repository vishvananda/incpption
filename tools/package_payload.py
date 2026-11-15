#!/usr/bin/env python3
"""Assemble a static compiler/clang/complete-project payload for browser qualification."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from artifact_transport import publish_bundle

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def prepare(args):
    out=args.output;out.mkdir(parents=True)
    reference=args.reference
    for name in ['manifest.json','manifest.sha256','w1-complete.json','release-origin.json']:
        shutil.copyfile(reference/name,out/name)
    manifest=json.loads((out/'manifest.json').read_text())
    for name in manifest['runner_files']:shutil.copyfile(reference/name,out/name)
    shutil.copytree(reference/'shim',out/'shim');shutil.copytree(reference/'licenses',out/'licenses')
    shutil.copytree(args.licenses,out/'licenses',dirs_exist_ok=True)
    w1=json.loads((out/'w1-complete.json').read_text())
    for row in w1['commands']:
        row['command'][0]='cppgm';src=reference/'inputs'/row['output'];dst=out/'inputs'/row['output'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
    (out/'w1-complete.json').write_text(json.dumps(w1,indent=2)+'\n')
    for level in [0,2]:
        name=f'x86-check/checks__floating.cpp.o.O{level}.native.o';dst=out/'inputs'/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(reference/'inputs'/name,dst)
    publish_bundle(reference/'bundle.bin',out,manifest)
    clang=out/'llvm';clang.mkdir()
    for name in ['manifest.json','manifest.sha256','transport.json']:
        shutil.copyfile(args.clang/name,clang/name)
    shutil.copytree(args.clang/'chunks',clang/'chunks')
    for runtime in json.loads((clang/'manifest.json').read_text())['runtime'].values():shutil.copyfile(args.clang/runtime['path'],clang/runtime['path'])
    for target in ['lara','doom','godot']:
        src=args.projects/target;dst=out/'projects'/target;dst.mkdir(parents=True)
        project=json.loads((src/'manifest.json').read_text())
        if any(Path(row['path']).suffix in ['.o','.a','.wasm','.cwasm']for row in project['files']):raise ValueError('precompiled project input in '+target)
        for name in ['manifest.json','manifest.sha256','transport.json']:shutil.copyfile(src/name,dst/name)
        for name in ['chunks','player','assets']:shutil.copytree(src/name,dst/name)
    # Notices identify the supplied runtime/data separately from site source.
    e=args.evidence
    for target,source in [('doom',e/'d3wasm-source'),('godot',e/'godot-source')]:
        dst=out/'licenses'/target;dst.mkdir(exist_ok=True)
        for path in source.iterdir():
            if path.is_file() and any(word in path.name.upper() for word in ['LICENSE','COPYING','COPYRIGHT']):shutil.copyfile(path,dst/path.name)
    credits='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credits · cppgm inception</title><link rel="stylesheet" href="wasi_demo.css"><main><h1>Credits</h1><p><a href="/">Back to cppgm inception</a></p><p><a href="https://github.com/vishvananda/cppgm">cppgm</a> v0.9.0 supplies the self-compiled WASI seed and source profile. <a href="compiler/manifest.json">Compiler inputs</a>.</p><p><a href="https://github.com/llvm/llvm-project">clang, LLVM and LLD</a> use Apache-2.0 with LLVM exceptions. Their generated headers and Emscripten host glue are supplied. <a href="llvm/manifest.json">clang build inputs</a>. See licenses/llvm/ for upstream notices.</p><p>OpenLara, Doom 3 and Godot source and supporting libraries are compiled in this browser. JavaScript host glue, generated headers and game data are supplied inputs. Game data retains its original licenses and is not covered by the site license.</p><ul><li><a href="projects/lara/manifest.json">OpenLara inputs and hashes</a> · <a href="licenses/OpenLara-LICENSE.txt">License</a></li><li><a href="projects/doom/manifest.json">Doom 3 inputs and hashes</a> · <a href="licenses/doom/COPYING.txt">Source license</a></li><li><a href="projects/godot/manifest.json">Godot inputs and hashes</a> · <a href="licenses/godot/LICENSE.txt">License</a></li></ul><p>Runtime and compiler SDK notices are in licenses/, including Emscripten, musl, libc++ and compiler-rt.</p></main></html>'''
    (out/'credits.html').write_text(credits)
    files=[dict(path=p.relative_to(out).as_posix(),size=p.stat().st_size,sha256=sha(p))for p in sorted(out.rglob('*'))if p.is_file()]
    args.lock.write_text(json.dumps(dict(schema=1,url=args.url,files=files),indent=2)+'\n')
    print('Static payload:',len(files),'files',flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['reference','clang','projects','licenses','evidence','output','lock']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--url',default='https://incpption.com');prepare(p.parse_args())
