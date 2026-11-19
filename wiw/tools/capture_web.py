#!/usr/bin/env python3
"""Capture upstream web build actions from fresh project checkouts."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess


def openlara(source, destination):
    web = source / 'src/platform/web'
    script = (web / 'build_wasm.bat').read_text()
    variables = dict(re.findall(r'^set (\w+)=(.*)$', script, re.M | re.I))
    command = next(line.removeprefix('call ') for line in script.splitlines()
                   if line.startswith('call em++ '))
    link = shlex.split(re.sub(r'%([A-Z]+)%', lambda match: variables[match[1]], command))
    flags = shlex.split(variables['FLAGS'])
    units = shlex.split(variables['SRC'])
    actions = [['em++', *flags, '-c', unit, '-o', Path(unit).stem + '.o'] for unit in units]
    (destination / 'openlara.json').write_text(json.dumps(
        {'directory': str(web), 'compile': actions, 'upstreamInvocation': link}, indent=2) + '\n')
    print(f'OpenLara: {len(actions)} compilations and the batch file link command')


def environment(emsdk):
    em = emsdk / 'upstream/emscripten'
    return dict(os.environ, EM_CONFIG=str(emsdk / '.emscripten'),
                PATH=os.pathsep.join([str(em), str(emsdk / 'upstream/bin'), os.environ['PATH']]))


def doom(source, destination, emsdk):
    env = environment(emsdk)
    em = emsdk / 'upstream/emscripten'
    build = destination / 'doom-build'
    subprocess.run(['cmake', '-S', source / 'neo', '-B', build, '-G', 'Ninja',
                    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
                    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
                    '-DCMAKE_TOOLCHAIN_FILE=' + str(em / 'cmake/Modules/Platform/Emscripten.cmake')],
                   check=True, env=env)
    with (destination / 'doom-commands.txt').open('w') as trace:
        subprocess.run(['ninja', '-C', build, '-t', 'commands'], check=True, stdout=trace)
    rows = json.loads((build / 'compile_commands.json').read_text())
    print(f'Doom 3: {len(rows)} compilations, plus archive and link commands')


def godot(source, destination, emsdk, scons):
    path = destination / 'godot-commands.txt'
    with path.open('w') as trace:
        subprocess.run([scons, '-C', source, '-n', 'platform=web', 'target=editor',
                        'threads=no', 'wasm_simd=no', 'lto=none', 'optimize=speed',
                        'verbose=yes', '-j4'], check=True, env=environment(emsdk),
                       stdout=trace, stderr=subprocess.STDOUT)
    rows = path.read_text().splitlines()
    count = sum(line.startswith(('em++ ', 'emcc ')) and ' -c ' in line for line in rows)
    if not count:
        raise ValueError(f'No compiler jobs in {path}; use a fresh checkout')
    print(f'Godot: {count} compilations, plus generators, archives and link commands')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', choices=('openlara', 'doom', 'godot'))
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--emsdk', type=Path)
    parser.add_argument('--scons', default='scons')
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if args.project != 'openlara' and not args.emsdk:
        parser.error('--emsdk is required for Doom 3 and Godot')
    output.mkdir(parents=True, exist_ok=True)
    if args.project == 'openlara':
        openlara(source, output)
    elif args.project == 'doom':
        doom(source, output, args.emsdk.resolve())
    else:
        godot(source, output, args.emsdk.resolve(), args.scons)


if __name__ == '__main__':
    main()
