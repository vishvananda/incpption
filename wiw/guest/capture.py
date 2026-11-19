#!/usr/bin/env python3
"""Record a complete build in a fixed Linux workspace."""
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

ROOT = Path('/tmp/incpption')
TOOLS = {'cc': 'gcc', 'gcc': 'gcc', 'c++': 'g++', 'g++': 'g++',
         'ar': 'ar', 'ranlib': 'ranlib', 'ld': 'ld', 'as': 'as'}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


WASI_TARGET = 'wasm32-wasip1'
WASI_ROOT = '/tmp/will-wasi'

PLACEHOLDER = b'\x7fELF build plan placeholder\n'


def explicit_output(args, option):
    if option in args:
        return Path(args[args.index(option) + 1])
    return None


def trace_output(name, args):
    if name == 'ar' and len(args) >= 2 and set(args[0].lstrip('-')) & {'r', 'q'}:
        return Path(args[1])
    if name == 'as' or name == 'ld':
        return explicit_output(args, '-o')
    if name not in ('cc', 'gcc', 'c++', 'g++') or '-E' in args or '-S' in args:
        return None
    output = explicit_output(args, '-o')
    if output:
        return output
    if '-c' in args:
        sources = [arg for arg in args if not arg.startswith('-') and
                   Path(arg).suffix in ('.c', '.cc', '.cpp', '.cxx', '.S', '.s')]
        if len(sources) == 1:
            return Path(Path(sources[0]).stem + '.o')
    return None


def trace_tool(name, args):
    if name == 'ranlib' and args and Path(args[-1]).is_file():
        if Path(args[-1]).read_bytes() == PLACEHOLDER:
            return True
    output = trace_output(name, args)
    if output is None:
        return False
    output.write_bytes(PLACEHOLDER)
    depfile = explicit_output(args, '-MF')
    if depfile:
        depfile.write_text(f'{output}:\n')
    return True

def wasi_args(name, args):
    language = ['-x', 'c'] if name in ('cc', 'gcc') and '-x' not in args and any(
        arg.endswith('.c') and not arg.startswith('-') for arg in args) else []
    return ['--target=' + WASI_TARGET, '--sysroot=' + WASI_ROOT + '/sysroot',
            '-resource-dir=' + WASI_ROOT + '/resource', *language, *args]


def tool_main(name):
    args = sys.argv[1:]
    log = os.environ.get('BUILD_PLAN_LOG')
    traced = log and os.environ.get('PLAN_MODE') == 'trace' and trace_tool(name, args)
    command = ['/usr/bin/' + TOOLS[name], *args]
    if os.environ.get('PLAN_TARGET') == WASI_TARGET and name in ('cc', 'gcc', 'c++', 'g++'):
        if args in (['-dumpmachine'], ['-print-target-triple']):
            print(WASI_TARGET)
            return 0
        command = [WASI_ROOT + '/cppgm', *wasi_args(name, args)]
    rc = 0 if traced else subprocess.call(command)
    if rc == 0 and log:
        action = {'tool': name, 'cwd': os.getcwd(), 'args': args}
        with open(log, 'a') as out:
            out.write(json.dumps(action) + '\n')
    return rc


def unpack(archive, source):
    with tarfile.open(archive) as tar:
        for item in tar:
            parts = item.name.split('/', 1)
            if len(parts) == 1:
                continue
            item.name = parts[1]
            if item.islnk():
                item.linkname = item.linkname.split('/', 1)[1]
            tar.extract(item, source, filter='data')


def commands(row, folder, build):
    options = row.get('options', [])
    system = row['system']
    wasi = os.environ.get('PLAN_TARGET') == WASI_TARGET
    if system == 'auto':
        systems = [
            (('configure',), 'configure'),
            (('CMakeLists.txt',), 'cmake'),
            (('meson.build',), 'meson'),
            (('Makefile', 'makefile', 'GNUmakefile'), 'make'),
            (('configure.py',), 'python'),
        ]
        if wasi:
            systems[0], systems[1] = systems[1], systems[0]
        for names, detected in systems:
            if any((folder / name).is_file() for name in names):
                system = detected
                break
    target = row.get('target')
    targets = [target] if target else []
    if wasi and system not in ('cmake', 'make'):
        raise ValueError('WASI plan generation supports CMake and Make projects')
    if system == 'cmake':
        toolchain = ['-DCMAKE_TOOLCHAIN_FILE=' + WASI_ROOT + '/wasi_toolchain.cmake',
                     '-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG', '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG'] if wasi else []
        return ['cmake', '-S', str(folder), '-B', str(build), '-G', 'Ninja',
                '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_AR=' + str(ROOT / 'bin/ar'),
                '-DCMAKE_RANLIB=' + str(ROOT / 'bin/ranlib'), *toolchain, *options], ['ninja', '-C', str(build), '-j1', *targets]
    if system == 'meson':
        return ['meson', 'setup', str(build), str(folder), '--buildtype=release', *options], ['ninja', '-C', str(build), '-j1', *targets]
    if system == 'python':
        return ['python3', 'configure.py', *options], ['ninja', '-j1', *targets]
    if system == 'configure':
        return ['sh', './configure', *options], ['make', '-j1', *targets]
    if system == 'make':
        return [], ['make', '-j1', *options, *targets]
    raise ValueError(f'Unknown build system {system}')


def is_binary(path):
    with path.open('rb') as handle:
        magic = handle.read(8)
    return magic.startswith((b'\x7fELF', b'\0asm')) or magic in (b'!<arch>\n', b'!<thin>\n')


def binaries(project):
    return {path for path in project.rglob('*')
            if not path.is_symlink() and path.is_file() and is_binary(path)}


def sdk_version():
    return {'machine': subprocess.check_output(['/usr/bin/gcc', '-dumpmachine'], text=True).strip(),
            'gcc': subprocess.check_output(['/usr/bin/gcc', '-dumpfullversion'], text=True).strip()}

def shared_library(path):
    return re.search(r'\.so(?:\.[0-9]+)*$', Path(path).name) is not None


def deliverable(path):
    return shared_library(path) or Path(path).suffix in ('', '.a', '.wasm')


def capture(row, batch, output, publish):
    start = time.monotonic()
    project = ROOT / row['id']
    source = project / 'source'
    source.mkdir(parents=True)
    mode = os.environ.get('PLAN_MODE', 'build')
    archive = batch / (row['id'] + '.tar.gz')
    if digest(archive) != row['sha256']:
        raise ValueError('Source checksum differs')
    unpack(archive, source)
    folder = source / row.get('sourceDirectory', '.')
    log = project / 'actions.jsonl'
    reproducibility = dict(TZ='UTC', LC_ALL='C', SOURCE_DATE_EPOCH='1735689600')
    env = dict(os.environ, **reproducibility, PATH=str(ROOT / 'bin') + ':/usr/local/bin:/usr/bin:/bin',
               CC='cc', CXX='c++', AR='ar', RANLIB='ranlib')
    target = os.environ.get('PLAN_TARGET', 'x86_64-linux-musl')
    config, build = commands(row, folder, project / 'build')
    if config:
        print('+', *config, flush=True)
        subprocess.run(config, cwd=folder, env=env, check=True)
    configure_products = binaries(project)
    print('+', *build, flush=True)
    subprocess.run(build, cwd=folder, env={**env, 'BUILD_PLAN_LOG': str(log)}, check=True)
    actions = [json.loads(line) for line in log.read_text().splitlines()]
    if not any('-c' in action['args'] for action in actions):
        raise ValueError('No compiler calls captured')
    products = []
    files = []
    for path in sorted(project.rglob('*')):
        if path == log or not (path.is_symlink() or path.is_file()):
            continue
        if not path.is_symlink() and is_binary(path):
            if path not in configure_products:
                product_hash = digest(path)
                placeholder_hash = hashlib.sha256(PLACEHOLDER).hexdigest()
                products.append({'path': str(path.relative_to(project)),
                                 'sha256': None if product_hash == placeholder_hash else product_hash})
        elif not path.is_symlink() or path.resolve().is_relative_to(project):
            files.append(path)
    if not any(deliverable(item['path']) for item in products):
        raise ValueError('No archive or executable produced')
    plan = {'schema': 1, 'project': row, 'target': target, 'mode': mode,
            'workspace': str(project), 'environment': reproducibility, 'sdk': sdk_version(),
            'actions': actions, 'products': products}
    publish(plan, project, files, output)
    result = {'id': row['id'], 'status': 'captured', 'actions': len(actions),
              'products': len(products), 'seconds': round(time.monotonic() - start, 2)}
    print('PLAN', json.dumps(result), flush=True)
    return result


def plan_archive(plan, project, files, output):
    name = plan['project']['id']
    with tarfile.open(output / (name + '.tar.gz'), 'w:gz', compresslevel=1) as bundle:
        data = json.dumps(plan, indent=2).encode()
        info = tarfile.TarInfo('plan.json')
        info.size = len(data)
        bundle.addfile(info, io.BytesIO(data))
        for path in files:
            bundle.add(path, arcname='workspace/' + str(path.relative_to(project)), recursive=False)


def run_batch(batch, output, publish=plan_archive):
    wrappers = ROOT / 'bin'
    wrappers.mkdir(parents=True)
    for name in TOOLS:
        (wrappers / name).symlink_to(Path(__file__).resolve())
    results = []
    for row in json.loads((batch / 'batch.json').read_text()):
        print('PROJECT', row['id'], flush=True)
        try:
            results.append(capture(row, batch, output, publish))
        except Exception as error:
            print('FAILED', row['id'], repr(error), flush=True)
            results.append({'id': row['id'], 'status': 'error', 'error': str(error)})
        shutil.rmtree(ROOT / row['id'], ignore_errors=True)
    (output / 'results.json').write_text(json.dumps(results, indent=2))


def main():
    run_batch(*map(Path, sys.argv[1:]))


if __name__ == '__main__':
    invoked = Path(sys.argv[0]).name
    sys.exit(tool_main(invoked) if invoked in TOOLS else main())
