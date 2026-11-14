#!/usr/bin/env python3
"""Prepare Emscripten runtime glue and an explicit cppgm link plan for OpenLara.

Emscripten links a reference only to choose its static runtime and JS imports.
The browser build independently compiles every program source and uses cppgm's
own linker. No reference program module is shipped by the static publisher.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='ported OpenLara directory')
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--compiler', required=True, type=Path)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    source, profile, compiler = args.source.resolve(), args.profile.resolve(), args.compiler.resolve()
    root = args.directory.resolve()
    root.mkdir()
    flags = json.loads((profile / 'profile.json').read_text())['compiler_flags']
    # The profile's paths deliberately remain relative inside a frozen browser
    # package. This precursor runs against the matching private SDK on disk.
    flags = [('--sysroot=' + str(profile / 'emscripten/cache/sysroot') if f.startswith('--sysroot=')
              else str(profile / f) if f.startswith('emscripten/') or f == 'cppgm_compat.h' else f)
             for f in flags]
    flags += ['-std=c++11', '-fno-rtti', '-I' + str(source / 'src')]
    objects = []
    for name in ['platform/web/main.cpp', 'libs/stb_vorbis/stb_vorbis.c', 'libs/tinf/tinflate.c']:
        obj = root / (Path(name).name + '.o')
        with (root / (obj.name + '.log')).open('wb') as log:
            subprocess.run([str(compiler), *flags, '-c', str(source / 'src' / name), '-o', str(obj)],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        objects.append(str(obj))
    post = root / 'post.js'
    post.write_text("Module['getMemory'] = () => wasmMemory;\n")
    command = [sys.executable, str(profile / 'emscripten/em++.py'), *objects, '-O2', '-v', '-fno-exceptions',
               '-sUSE_WEBGL2=1', '-sALLOW_MEMORY_GROWTH=1', '-sASSERTIONS=1', '-sSTACK_SIZE=8388608',
               '-sINITIAL_MEMORY=67108864', '-sMODULARIZE=1', '-sEXPORT_NAME=OpenLara', '-sEXPORT_ES6=1',
               '-sEXPORTED_FUNCTIONS=["_main","_malloc","_free","_set_def_lang","_snd_fill","_game_level_load","_change_fs_mode"]',
               '-sEXPORTED_RUNTIME_METHODS=["ccall","GL","FS"]', '--post-js', str(post), '-o', str(root / 'runtime.mjs')]
    with (root / 'reference-link.log').open('wb') as log:
        subprocess.run(command, env=dict(os.environ, EM_CONFIG=str(profile / 'emconfig')),
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    script = 'const m=new WebAssembly.Module(require("fs").readFileSync(process.argv[1]));console.log(JSON.stringify({imports:WebAssembly.Module.imports(m),exports:WebAssembly.Module.exports(m)}));'
    interface = json.loads(subprocess.check_output([args.node, '-e', script, str(root / 'runtime.wasm')]))
    line = next(line for line in (root / 'reference-link.log').read_text().splitlines() if '/wasm-ld ' in line)
    arguments = shlex.split(line)
    roots = [Path(a[2:]) for a in arguments if a.startswith('-L')]
    libraries = []
    for arg in arguments:
        if arg.startswith('-l'):
            lib = next((p / ('lib' + arg[2:] + '.a') for p in roots if (p / ('lib' + arg[2:] + '.a')).is_file()), None)
            if lib is None:
                raise RuntimeError('missing SDK archive: ' + arg)
            libraries.append(str(lib))
    flags = ['--target=wasm32-unknown-unknown', '-nostdlib', '-Wl,-z,stack-size=8388608',
             '--export-ctors', '--export-table']
    for item in interface['exports']:
        if item['kind'] == 'function' and item['name'] != '__wasm_call_ctors':
            flags += ['--export', item['name']]
    for item in interface['imports']:
        if item['kind'] == 'function' and item['module'] == 'wasi_snapshot_preview1':
            continue  # The linker's typed WASI runtime imports already cover these.
        if item['kind'] != 'function' or item['module'] != 'env':
            raise RuntimeError('unexpected reference runtime import: ' + str(item))
        flags += ['--import-function', item['name']]
    plan = [str(compiler), *flags, *objects, *libraries, '-o', str(root / 'own-reference.wasm')]
    (root / 'link-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    (root / 'interface.json').write_text(json.dumps(interface, indent=2) + '\n')
    print('Prepared SDK runtime glue and explicit cppgm link plan')


if __name__ == '__main__':
    main()
