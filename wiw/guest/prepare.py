#!/usr/bin/env python3
"""Bind the captured plans to the small browser C/C++ toolchain."""

import argparse
import gzip
from hashlib import sha256
import json
from pathlib import Path
import posixpath
import shlex
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from capture import TOOLS, WASI_TARGET, deliverable, sdk_version, shared_library, wasi_args
from replay import unpack_workspace

CPP_SUFFIXES = {'.C', '.cc', '.cpp', '.cxx', '.c++'}
DRIVERS = {'cc', 'gcc', 'c++', 'g++'}


def encode_json(data):
    return json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode()


def snapshot_bytes(files):
    entries, data = [], bytearray()
    for name, blob in sorted(files.items()):
        entries.append({'path': name, 'offset': len(data), 'size': len(blob)})
        data.extend(blob)
    payload = encode_json(entries)
    return len(payload).to_bytes(4, 'little') + payload + data


def package(output, stem, files):
    content = snapshot_bytes(files)
    path = stem + '.bin'
    transport = gzip.compress(content, mtime=0)
    (output / path).write_bytes(transport)
    return {'path': path, 'sha256': sha256(content).hexdigest(), 'bytes': len(transport)}


def include_paths(language):
    command = ['/usr/bin/gcc', '-E', '-x', language, '-v', '/dev/null']
    result = subprocess.run(command, capture_output=True, check=True, text=True)
    lines = result.stderr.split('#include <...> search starts here:\n', 1)[1]
    return lines.split('End of search list.', 1)[0].split()


def absolute(cwd, name):
    return posixpath.normpath(posixpath.join(cwd, name))


def expand_link(driver, args, cwd):
    run = subprocess.run(['/usr/bin/' + TOOLS[driver], '-###', *args],
                         cwd=cwd, text=True, capture_output=True, check=True)
    lines = [shlex.split(line) for line in run.stderr.splitlines() if line.startswith(' ')]
    tools = [parts for parts in lines if parts and Path(parts[0]).name == 'collect2']
    if len(tools) != 1:
        raise ValueError(f'Expected one GCC link invocation, found {len(tools)}')
    result = []
    args = iter(tools[0][1:])
    for arg in args:
        if arg == '-plugin':
            next(args)
        elif not arg.startswith('-plugin-opt='):
            result.append(arg)
    return result


def link_inputs(args, cwd, products, bounds, sdk):
    """Collect the exact SDK archives, objects and linker scripts used by GCC's expansion."""
    searches = [absolute(cwd, flag[2:]) for flag in args if flag.startswith('-L')]
    inputs = []

    def select(name, prefixes):
        for folder in searches:
            for prefix in prefixes:
                path = absolute(folder, prefix + name)
                if path in products or Path(path).is_file():
                    return path
        raise ValueError(f'Link input {name} missing for {cwd}')

    for index, arg in enumerate(args):
        if index and args[index - 1] in ('-o', '-h', '-soname', '--soname', '-dynamic-linker', '--dynamic-linker'):
            continue
        if arg.startswith('-l'):
            lib = arg[2:]
            if lib.startswith(':'):
                path = select(lib[1:], ('',))
            else:
                for folder in searches:
                    candidates = [absolute(folder, 'lib' + lib + ext) for ext in ('.so', '.a')]
                    path = next((p for p in candidates if p in products or Path(p).is_file()), None)
                    if path:
                        break
                if not path:
                    raise ValueError(f'Could not resolve {arg}')
            inputs.append(path)
        elif not arg.startswith('-') and (arg.endswith(('.a', '.o')) or shared_library(arg)):
            inputs.append(absolute(cwd, arg))
    output = absolute(cwd, args[args.index('-o') + 1])
    for path in tuple(inputs):
        if path.endswith('/libgcc_s.so') and not Path(path).read_bytes().startswith(b'\x7fELF'):
            inputs.append(select('libgcc_s.so.1', ('',)))
    for path in inputs:
        if path != output and not path.startswith(bounds + '/'):
            sdk.add(path)
    return sorted((set(inputs) & products) - {output})


def workflow(plan, workspace, includes, sdk_inputs):
    root = workspace.as_posix()
    epoch = plan['environment']['SOURCE_DATE_EPOCH']
    steps, outputs, producers = {}, {}, {}
    products = {absolute(root, row['path']) for row in plan['products']}
    wasi = plan['target'] == WASI_TARGET

    for action in plan['actions']:
        driver, cwd, args = action['tool'], action['cwd'], action['args']
        deps = []
        name = f'action{len(steps)}'
        if driver in DRIVERS and ('-c' in args or '-E' in args):
            source = next(arg for arg in args if not arg.startswith('-')
                          and Path(arg).suffix in CPP_SUFFIXES | {'.c', '.S', '.s'})
            cpp = driver in ('c++', 'g++') or Path(source).suffix in CPP_SUFFIXES
            include_args = [arg for path in includes['c++' if cpp else 'c'] for arg in ('-isystem', path)]
            standard = [] if any(arg.startswith('-std=') for arg in args) else ['-std=gnu++17' if cpp else '-std=gnu17']
            command = 'cppgm'
            if '-c' in args:
                out = args[args.index('-o') + 1] if '-o' in args else Path(source).stem + '.o'
            else:
                out = '.incpption/' + name + '.tokens'
            args = wasi_args(driver, args) if wasi else ['-nostdinc', *standard, *args, *include_args]
            if '-o' not in args:
                args += ['-o', out]
        elif driver == 'ar' and set(args[0]) <= set('qrcsDu') and set(args[0]) & set('qr'):
            command, out = 'ar', args[1]
            deps = [absolute(cwd, path) for path in args[2:]]
        elif driver == 'ranlib':
            # The browser archiver writes the same index as GNU ar + ranlib.
            if absolute(cwd, args[0]) not in producers:
                raise ValueError('ranlib requires a recorded archive')
            continue
        elif driver in DRIVERS and args in (['--version'], ['-dumpmachine']):
            # Their results are already reflected in the frozen commands.
            continue
        elif driver in DRIVERS and wasi:
            command = 'wasi-link'
            out = args[args.index('-o') + 1] if '-o' in args else 'a.out'
            if '-o' not in args:
                args += ['-o', out]
            args = wasi_args(driver, args)
            deps = sorted({absolute(cwd, arg) for arg in args if not arg.startswith('-')
                           and absolute(cwd, arg) in producers})
        elif driver in DRIVERS:
            command = 'ld.lld'
            args = expand_link(driver, args, cwd)
            out = args[args.index('-o') + 1]
            deps = link_inputs(args, cwd, products, root, sdk_inputs)
        else:
            raise ValueError(f'Unsupported plan action: {driver} {args}')

        result = absolute(cwd, out)
        if not result.startswith(root + '/') or result in producers:
            raise ValueError(f'Invalid or duplicate output {result}')
        ref = 'file'
        wiring = {'snapshot': 'snapshot'}
        inputs = {'snapshot': {'type': 'Directory', 'loadListing': 'shallow_listing'}}
        listing = ['$(inputs.snapshot.listing)']
        for path in deps:
            key = f'in{len(wiring)}'
            wiring[key] = producers[path]
            inputs[key] = 'File'
            listing.append({'entry': f'$(inputs.{key})', 'entryname': path.removeprefix(root + '/')})

        tool = {
            'class': 'CommandLineTool', 'baseCommand': 'env', 'arguments': [f'--chdir={cwd}', '--', command, *args],
            'requirements': {
                'InitialWorkDirRequirement': {'listing': listing},
                'DockerRequirement': {'dockerImageId': 'willitwasm-wasi' if wasi else 'incpption-browser-x86_64-musl', 'dockerOutputDirectory': root},
                'EnvVarRequirement': {'envDef': {'SOURCE_DATE_EPOCH': epoch}},
            },
            'inputs': inputs, 'outputs': {
                ref: {'type': 'File', 'outputBinding': {'glob': result.removeprefix(root + '/')}},
            },
        }
        steps[name] = {'run': tool, 'in': wiring, 'out': [ref]}
        producers[result] = name + '/' + ref
        if result in products and deliverable(result):
            outputs[f'product{len(outputs)}'] = {'type': 'File', 'outputSource': producers[result]}

    return {
        'cwlVersion': 'v1.2', 'class': 'Workflow', 'label': plan['project']['id'],
        'inputs': {'snapshot': 'Directory'}, 'outputs': outputs, 'steps': steps,
    }


def link_assets(paths):
    files = {}
    with tempfile.TemporaryDirectory() as scratch:
        for path in sorted(paths):
            native = Path(path)
            blob = native.read_bytes()
            if blob[:4] == b'\x7fELF' or blob[:8] == b'!<arch>\n':
                # The browser LLD was built without zlib. Ignore debug
                # sections on supplied SDK objects, never on project objects.
                output = Path(scratch) / native.name
                subprocess.run(['/usr/bin/objcopy', '--strip-debug', path, output], check=True)
                blob = output.read_bytes()
            files[path.lstrip('/')] = blob
    return files


def standard_link_inputs():
    names = ('Scrt1.o', 'crti.o', 'crtn.o', 'crtbeginS.o', 'crtendS.o', 'libgcc.a',
             'libc.so', 'libdl.a', 'libgcc_s.so', 'libgcc_s.so.1', 'libm.a',
             'libssp_nonshared.a', 'libstdc++.so')
    paths = set()
    for name in names:
        path = subprocess.check_output(['/usr/bin/g++', '-print-file-name=' + name], text=True).strip()
        if not path.startswith('/') or not Path(path).is_file():
            raise ValueError(f'Missing SDK input {name}')
        paths.add(posixpath.normpath(path))
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plans', type=Path, nargs='?', help='Plan directory. Omit to package the SDK only.')
    parser.add_argument('destination', type=Path)
    parser.add_argument('--ninja-profile', type=Path, help='Write the target SDK defaults for browser Ninja replay.')
    options = parser.parse_args()
    options.destination.mkdir(parents=True, exist_ok=True)
    includes = {language: include_paths(language) for language in ('c', 'c++')}
    common = set(map(posixpath.normpath, includes['c']))
    cxx = set(map(posixpath.normpath, includes['c++'])) - common

    def headers(directories):
        return {str(path).lstrip('/'): path.read_bytes()
                for directory in sorted(directories)
                for path in Path(directory).rglob('*') if path.is_file()}

    cxx_headers = headers(cxx)
    c_headers = {name: blob for name, blob in headers(common).items() if name not in cxx_headers}
    manifest = {
        'sdk': sdk_version(),
        'includePaths': includes,
        'headers': package(options.destination, 'headers', c_headers),
        'cxxHeaders': package(options.destination, 'cxx-headers', cxx_headers),
        'projects': {},
    }
    sdk_inputs = standard_link_inputs() if options.plans is None else set()
    bundles = sorted(options.plans.glob('*.tar.gz')) if options.plans is not None else []
    for bundle in bundles:
        plan, workspace = unpack_workspace(bundle)
        project = plan['project']['id']
        cwl = workflow(plan, workspace, includes, sdk_inputs)
        (options.destination / (project + '.cwl')).write_bytes(encode_json(cwl))
        files = {
            str(path).lstrip('/'): path.read_bytes()
            for path in workspace.rglob('*')
            if path.is_file() and path.resolve().is_relative_to(workspace)
        }
        manifest['projects'][project] = package(options.destination, project, files)
    cxx_link = {path for path in sdk_inputs if Path(path).name.startswith('libstdc++')}
    manifest['link'] = package(options.destination, 'link', link_assets(sdk_inputs - cxx_link))
    manifest['cxxLink'] = package(options.destination, 'cxx-link', link_assets(cxx_link))
    (options.destination / 'manifest.json').write_bytes(encode_json(manifest))
    if options.ninja_profile:
        placeholders = ['-o', '__output__', '__input__.o', '-L__search__', '-l__library__']
        options.ninja_profile.write_bytes(encode_json({
            'sdk': manifest['sdk'],
            'includePaths': includes,
            'link': {language: expand_link(driver, placeholders, '/tmp')
                     for language, driver in (('c', 'gcc'), ('c++', 'g++'))},
        }))


if __name__ == '__main__':
    main()
