"""Compiler and linker shims for the native Emscripten plan generator."""
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import uuid

SOURCE_SUFFIXES = {'.c', '.cc', '.cpp', '.cxx', '.C', '.s', '.S'}
EPOCH = '1735689600'


def expand(args):
    for arg in args:
        if arg.startswith('@'):
            yield from expand(shlex.split(Path(arg[1:]).read_text()))
        else:
            yield arg


def option(args, key):
    for index, arg in enumerate(args):
        if arg == key:
            return args[index + 1]
        if arg.startswith(key) and key in ('-o', '-MF') and len(arg) > len(key):
            return arg[len(key):]
    return None


def absolute(value):
    return Path(os.path.abspath(value))


def compiler_args(args, source, clang, compat):
    language = option(args, '-x')
    if not language:
        language = {'.S': 'assembler-with-cpp', '.s': 'assembler'}.get(source.suffix)
        language = language or ('c' if source.suffix == '.c' and '++' not in clang else 'c++')
    result = ['-x', language, '-D__GNUC__=4', '-D__GNUC_MINOR__=2', '-D__GNUC_PATCHLEVEL__=1',
              '-D_GNU_SOURCE=1', '-D__unix__=1', '-D__unix=1', '-Dunix=1']
    if language == 'c++':
        result += ['-D__GNUG__=4', '-D__GXX_ABI_VERSION=1002']
    if compat:
        result += ['-include', compat]
    system_includes = set(json.loads(os.environ['WW_SYSTEM_INCLUDES']))
    output = option(args, '-o')
    iterator = iter(args)
    for arg in iterator:
        if arg == '-target':
            result.append('--target=' + next(iterator))
        elif output and arg == '-o' + output:
            result += ['-o', arg[2:]]
        elif arg == '-I':
            include = next(iterator)
            if str(absolute(include)) not in system_includes:
                result += ['-I', include]
        elif arg.startswith('-I') and str(absolute(arg[2:])) in system_includes:
            continue
        elif arg.startswith('--std='):
            result.append(arg[1:])
        elif arg in ('-x', '-mllvm'):
            # cppgm chooses its Emscripten ABI from the target, including Wasm SJLJ.
            next(iterator)
        elif arg == '-Xclang':
            value = next(iterator)
            if not value.startswith('-iwithsysroot'):
                raise ValueError(f'Unsupported Clang option: {value}')
            sysroot = next(a.split('=', 1)[1] for a in args if a.startswith('--sysroot='))
            result += ['-isystem', sysroot + value.removeprefix('-iwithsysroot')]
        elif arg == '-fignore-exceptions':
            result.append('-fno-exceptions')
        else:
            result.append(arg)
    return result


def record(root, row):
    path = root / (uuid.uuid4().hex + '.json')
    path.write_text(json.dumps({'cwd': str(Path.cwd()), **row}))


def compiler_environment():
    env = os.environ.copy()
    env.update(LD_PRELOAD=env['WW_TIME_SHIM'], TZ='UTC')
    return env


def compile_project(root, args, real):
    workspace = Path(os.environ['WW_WORKSPACE'])
    sources = [absolute(arg) for arg in args if not arg.startswith('-')
               and Path(arg).suffix in SOURCE_SUFFIXES and Path(arg).is_file()]
    if '-c' not in args or len(sources) != 1 or not sources[0].is_relative_to(workspace):
        return subprocess.call([real, *args])
    source, out = sources[0], option(args, '-o')
    if out is None:
        raise ValueError('Project compilation requires an explicit output path')
    output = absolute(out)
    command = compiler_args(args, source, real, os.environ.get('WW_COMPAT'))
    dep = root / (uuid.uuid4().hex + '.d')
    command = [os.path.relpath(source) if not arg.startswith('-') and absolute(arg) == source else arg
               for arg in command]
    cppgm = os.environ['WW_CPPGM']
    opens = dep.with_suffix('.opens')
    status = subprocess.call(['strace', '-qq', '-e', 'trace=open,openat', '-s', '8192', '-xx',
                              '-o', opens, cppgm, *command], env=compiler_environment())
    if status:
        return status
    roots = [Path(path) for path in json.loads(os.environ['WW_ROOTS'])]
    names = set()
    with opens.open() as stream:
        for line in stream:
            match = re.match(r'open(?:at\(AT_FDCWD, |\()"([\\x0-9a-f]+)", O_RDONLY[^)]*\) = \d+', line)
            if match:
                path = absolute(os.fsdecode(bytes.fromhex(match[1].replace('\\x', ''))))
                if any(path.is_relative_to(parent) for parent in roots) and path.is_file():
                    names.add(str(path))
    names = sorted(names)
    opens.unlink()
    dep.write_text(json.dumps(names))
    requested_dep = option(args, '-MF')
    if requested_dep:
        make_paths = [name.replace(' ', '\\ ') for name in (out, *names)]
        Path(requested_dep).write_text(make_paths[0] + ': ' + ' '.join(make_paths[1:]) + '\n')
    record(root, dict(tool='compile', args=command, source=str(source), output=str(output), dep=str(dep)))
    return 0


def capture_link(root, real, args):
    output = option(args, '-o')
    if not output or not Path.cwd().is_relative_to(Path(os.environ['WW_WORKSPACE'])) or any(
            arg in args for arg in ('--relocatable', '-r', '--version')):
        return subprocess.call([real, *args])
    slot = root / uuid.uuid4().hex
    slot.mkdir()
    repro = slot / 'link.tar'
    status = subprocess.call([real, *args, '--reproduce=' + str(repro)])
    if status:
        return status
    shutil.copyfile(output, slot / 'raw.wasm')
    record(root, dict(tool='link', output=str(absolute(output)), args=args, raw=str(slot / 'raw.wasm'),
                      reproduction=str(repro)))
    return 0


def capture_post(root, role, args):
    real = Path(os.environ['WW_LLVM']) / role
    if '-o' not in args or not Path.cwd().is_relative_to(Path(os.environ['WW_WORKSPACE'])):
        return subprocess.call([real, *args])
    slot = root / uuid.uuid4().hex
    slot.mkdir()
    out_index = args.index('-o') + 1
    inputs = {}
    for index, arg in enumerate(args):
        if index == out_index:
            continue
        option, separator, name = arg.partition('=')
        file = Path(name if separator else option)
        if file.is_file():
            stored = slot / str(index)
            shutil.copyfile(file, stored)
            inputs[str(index)] = {'path': str(stored), 'prefix': option + separator if separator else ''}
    status = subprocess.call([real, *args])
    if status:
        return status
    output = slot / 'output.wasm'
    shutil.copyfile(args[out_index], output)
    record(root, dict(tool='post', binary=role, args=args, files=inputs,
                      output=str(output), output_index=out_index))
    return status


def emscripten_driver(role, args):
    driver = Path(os.environ['WW_EMSCRIPTEN']) / role
    sources = any(not arg.startswith('-') and Path(arg).suffix in SOURCE_SUFFIXES for arg in args)
    if option(args, '-o') and not sources and not any(flag in args for flag in ('-c', '-E', '-S', '-M', '-MM')):
        args = [*args, os.environ['WW_LINK_OPT']]
    return subprocess.call([driver, *args])


def main():
    role = os.environ['WW_ROLE']
    root = Path(os.environ['WW_TRACE'])
    if role in ('emcc', 'em++'):
        return emscripten_driver(role, list(expand(sys.argv[1:])))
    if role == 'trace-compiler':
        real, *args = sys.argv[1:]
        return compile_project(root, list(expand(args)), real)
    if role in ('wasm-opt', 'wasm-metadce', 'wasm-emscripten-finalize'):
        return capture_post(root, role, sys.argv[1:])
    real = str(Path(os.environ['WW_LLVM']) / role)
    args = list(expand(sys.argv[1:]))
    if role == 'wasm-ld':
        return capture_link(root, real, args)
    status = subprocess.call([real, *args])
    if (role == 'llvm-ar' and status == 0 and len(args) >= 3 and
            absolute(args[1]).is_relative_to(Path(os.environ['WW_WORKSPACE']))):
        if args[0].lstrip('-') not in ('rc', 'rcs', 'rcsD', 'qc', 'cr', 'crs', 'r', 'rsc'):
            raise ValueError(f'Unsupported archive mode: {args[0]}')
        record(root, dict(tool='archive', output=str(absolute(args[1])),
                          members=[str(absolute(member)) for member in args[2:]]))
    return status


if __name__ == '__main__':
    sys.exit(main())
