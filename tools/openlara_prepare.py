#!/usr/bin/env python3
"""Freeze an OpenLara browser build from a prepared source/SDK/runtime profile."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler-package', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path, help='prepared OpenLara src directory')
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--link-plan', required=True, type=Path)
    parser.add_argument('--assets', required=True, type=Path)
    args = parser.parse_args()
    compiler_package = args.compiler_package.resolve()
    package = compiler_package / 'openlara'
    package.mkdir()  # Never replace a prior experiment.
    inputs = package / 'inputs'
    inputs.mkdir()
    shutil.copytree(args.source, inputs / 'openlara/src')
    core = inputs / 'openlara/src/core.h'
    text = core.read_text()
    old = 'static const char *version = __DATE__;'
    if text.count(old) != 1:
        raise RuntimeError('unexpected OpenLara version stamp')
    core.write_text(text.replace(old, 'static const char *version = OPENLARA_BUILD_DATE;'))
    shutil.copytree(args.profile / 'emscripten/cache/sysroot/include', inputs / 'emscripten/cache/sysroot/include')
    shutil.copyfile(args.profile / 'cppgm_compat.h', inputs / 'cppgm_compat.h')
    (inputs / 'lib').mkdir()
    plan = json.loads(args.link_plan.read_text())
    libraries = []
    for name in plan:
        if name.endswith('.a'):
            target = inputs / 'lib' / Path(name).name
            shutil.copyfile(name, target)
            libraries.append(str(target.relative_to(inputs)))
    flags = json.loads((args.profile / 'profile.json').read_text())['compiler_flags']
    stamp = datetime.now(timezone.utc)
    flags += ['-std=c++11', '-fno-rtti', '-Iopenlara/src',
              '-DOPENLARA_BUILD_DATE="' + stamp.strftime('%b %d %Y') + '"']
    sources = ['openlara/src/platform/web/main.cpp', 'openlara/src/libs/stb_vorbis/stb_vorbis.c',
               'openlara/src/libs/tinf/tinflate.c']
    objects = ['main.o', 'stb_vorbis.o', 'tinflate.o']
    (inputs / 'native').mkdir()
    commands = []
    observations = []
    compiler = str(compiler_package / 'native-compiler')

    def run(arguments, name):
        started = time.monotonic()
        with (package / (name + '.log')).open('wb') as log:
            result = subprocess.run([compiler, *arguments], cwd=inputs, stdout=log, stderr=subprocess.STDOUT)
        row = dict(command=[compiler, *arguments], seconds=time.monotonic() - started, exit=result.returncode)
        observations.append(row)
        save(package / 'native-observations.json', observations)
        if result.returncode:
            raise RuntimeError(f'{name}: compilation failed; see {package / (name + ".log")}')

    for source, obj in zip(sources, objects):
        run([*flags, '-c', source, '-o', 'native/' + obj], obj)
        commands.append(dict(name=source, args=[*flags, '-c', source, '-o', 'build/' + obj],
                             output='build/' + obj, expected='native/' + obj))
    first_object = next(i for i, item in enumerate(plan) if item.endswith('.o'))
    link_flags = plan[1:first_object]
    run([*link_flags, *['native/' + name for name in objects], *libraries, '-o', 'native/openlara.wasm'], 'link')
    commands.append(dict(name='Link OpenLara', args=[*link_flags, *['build/' + name for name in objects],
                                                  *libraries, '-o', 'build/openlara.wasm'],
                         output='build/openlara.wasm', expected='native/openlara.wasm'))
    asset_names = ['level/1/TITLE.PSX', 'level/1/LEVEL1.PSX', 'level/1/AMERTIT.PNG',
                   'level/1/AZTECLOA.PNG', 'audio/1/track_02.ogg', 'audio/1/track_05.ogg']
    for name in asset_names:
        target = inputs / 'assets' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.assets / name, target)
    shutil.copyfile(args.runtime, inputs / 'runtime.mjs')
    runtime_name = 'runtime.' + digest(args.runtime.read_bytes()) + '.mjs'
    shutil.copyfile(args.runtime, package / runtime_name)
    files = []
    with (package / 'bundle.bin').open('wb') as bundle:
        for path in sorted(inputs.rglob('*')):
            if not path.is_file():
                continue
            data = path.read_bytes()
            files.append(dict(path=path.relative_to(inputs).as_posix(), offset=bundle.tell(),
                              size=len(data), sha256=digest(data)))
            bundle.write(data)
    manifest = dict(schema=1, compiler_manifest=digest((compiler_package / 'manifest.json').read_bytes()),
                    commands=commands, assets=asset_names, files=files,
                    bundle_sha256=digest((package / 'bundle.bin').read_bytes()))
    # Runtime glue belongs to the frozen payload; browser UI and workers are
    # versioned independently in web/ and assembled by build.py.
    manifest['runner_files'] = {runtime_name: digest((package / runtime_name).read_bytes())}
    save(package / 'manifest.json', manifest)
    (package / 'manifest.sha256').write_text(digest((package / 'manifest.json').read_bytes()) + '\n')
    print(f'Frozen {len(files)} files; {len(commands)} browser build commands')


if __name__ == '__main__':
    main()
