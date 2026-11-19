#!/usr/bin/env python3
"""Run a trusted local Emscripten build with cppgm and export a browser replay plan."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import struct
import subprocess
import sys
import tarfile

from capture_web import environment
from emscripten_trace import EPOCH, absolute, option


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def install_shim(target):
    script = Path(__file__).with_name('emscripten_trace.py').resolve()
    target.write_text(f'#!/bin/sh\nexport WW_ROLE={target.name}\n'
                      f'exec {shlex.quote(sys.executable)} {shlex.quote(str(script))} "$@"\n')
    target.chmod(0o755)


def build(args, trace):
    sdk = args.emsdk / 'upstream'
    env = environment(args.emsdk)
    cache = args.cache or sdk / 'emscripten/cache'
    facade = trace / 'bin'
    facade.mkdir()
    tools = ('wasm-ld', 'llvm-ar', 'wasm-opt', 'wasm-metadce', 'wasm-emscripten-finalize')
    for item in (sdk / 'bin').iterdir():
        if item.name not in tools:
            (facade / item.name).symlink_to(item)
    install_shim(trace / 'trace-compiler')
    for name in tools:
        install_shim(facade / name)
    (trace / 'tmp').mkdir()
    shim = trace / 'frozen-time.so'
    subprocess.run(['cc', '-shared', '-fPIC', '-O2', Path(__file__).with_name('frozen_time.c'),
                    '-o', shim], check=True)
    env.update(EM_BINARYEN_ROOT=str(trace), EMCC_SKIP_SANITY_CHECK='1', EMCC_TEMP_DIR=str(trace / 'tmp'),
               WW_WORKSPACE=str(args.workspace), WW_CPPGM=str(args.compiler), WW_TIME_SHIM=str(shim),
               WW_TRACE=str(trace), WW_LLVM=str(sdk / 'bin'),
               EM_COMPILER_WRAPPER=str(trace / 'trace-compiler'), EM_LLVM_ROOT=str(facade),
               EM_CACHE=str(cache), SOURCE_DATE_EPOCH=EPOCH)
    if args.link_opt:
        drivers = trace / 'drivers'
        drivers.mkdir()
        for tool in ('emcc', 'em++'):
            install_shim(drivers / tool)
        env.update(WW_EMSCRIPTEN=str(sdk / 'emscripten'), WW_LINK_OPT=args.link_opt,
                   PATH=str(drivers) + os.pathsep + env['PATH'])
    env['WW_SYSTEM_INCLUDES'] = json.dumps([str(path / 'sysroot/include') for path in
                                            (cache, sdk / 'emscripten/cache')])
    env['WW_ROOTS'] = json.dumps([str(root) for root in
                                  (args.workspace, sdk / 'emscripten', sdk / 'lib', cache, trace, args.compat) if root])
    if args.compat:
        env['WW_COMPAT'] = str(args.compat)
    if args.config:
        env['EM_CONFIG'] = str(args.config)
    version = subprocess.check_output(['emcc', '-dumpversion'], env=env, text=True).strip()
    if version != '4.0.9':
        raise ValueError(f'The replay adapter uses Emscripten 4.0.9. Found {version}.')
    subprocess.run(args.command, cwd=args.workspace, env=env, check=True)
    return version, cache


class Bundle:
    def __init__(self, output):
        self.output = output
        self.files = {}

    def add(self, name, data):
        if name in self.files and self.files[name] != data:
            raise ValueError(f'Conflicting captured file: {name}')
        self.files[name] = data

    def write(self, filename):
        position, index = 0, []
        for name, data in sorted(self.files.items()):
            index.append(dict(path=name, offset=position, size=len(data)))
            position += len(data)
        header = json.dumps(index, separators=(',', ':')).encode()
        checksum = hashlib.sha256()
        with (self.output / filename).open('wb') as stream:
            with gzip.GzipFile(fileobj=stream, mode='wb', filename='', mtime=0, compresslevel=6) as encoded:
                for block in (struct.pack('<I', len(header)), header, *(self.files[row['path']] for row in index)):
                    encoded.write(block)
                    checksum.update(block)
        return dict(path=filename, encoding='gzip', bytes=4 + len(header) + position, sha256=checksum.hexdigest())


class Workspace:
    def __init__(self, workspace, cache, trace, compat, emscripten):
        self.roots = [(trace, 'trace'), (cache, 'sdk'), (workspace, 'checkout'), (emscripten, 'emscripten'),
                      (emscripten.parent / 'lib', 'toolchain/lib')]
        if compat:
            self.roots.insert(0, (compat, 'sdk/cppgm_compat.h'))

    def name(self, value):
        path = absolute(value)
        for root, label in self.roots:
            if path.is_relative_to(root):
                relative = path.relative_to(root).as_posix()
                return label if relative == '.' else label + '/' + relative
        raise ValueError(f'Build input is outside the project and SDK: {path}')

    def arguments(self, args):
        result = []
        for arg in args:
            for root, label in self.roots:
                # Replace whole path prefixes including joined options and macro values.
                arg = re.sub(re.escape(str(root)) + r'(?=/|$)', '/' + label, arg)
            result.append(arg)
        return result


def wasm_sections(data):
    def uleb(offset):
        result, shift = 0, 0
        while data[offset] & 128:
            result |= (data[offset] & 127) << shift
            offset += 1
            shift += 7
        return result | (data[offset] << shift), offset + 1

    offset = 8
    while offset < len(data):
        size, payload = uleb(offset + 1)
        end = payload + size
        name = None
        if data[offset] == 0:
            length, start = uleb(payload)
            name = data[start:start + length].decode()
        yield name, data[offset:end]
        offset = end


def removed_sections(before, after):
    if before[:8] != b'\0asm\x01\0\0\0' or before[:8] != after[:8]:
        return []
    sections = list(wasm_sections(before))
    kept = {name for name, _ in wasm_sections(after)}
    names = sorted({name for name, _ in sections if name is not None and name not in kept})
    if names and before[:8] + b''.join(raw for name, raw in sections if name not in names) == after:
        return names
    return []


def post_link(rows, raw, final, inputs):
    stages, current = [], raw
    while current != final:
        matches = []
        for row in rows:
            binaries = [index for index, value in row['files'].items()
                        if Path(value['path']).read_bytes() == current]
            if len(binaries) == 1 and Path(row['output']).read_bytes() != current:
                matches.append((row, binaries[0]))
        if not matches:
            candidates = [final, *(Path(file['path']).read_bytes() for row in rows for file in row['files'].values())]
            for candidate in candidates:
                sections = removed_sections(current, candidate)
                if sections:
                    current = candidate
                    stages.append(dict(tool='strip-custom', sections=sections, sha256=digest(current)))
                    break
            else:
                raise ValueError('Unrecorded Emscripten post-link Wasm transformation')
            continue
        if len(matches) != 1:
            raise ValueError('Unrecorded or ambiguous Emscripten post-link Wasm transformation')
        row, binary = matches[0]
        command = list(row['args'])
        index = len(stages)
        for slot, file in row['files'].items():
            if slot == binary:
                command[int(slot)] = file['prefix'] + 'input.wasm'
            else:
                path = f'post/{index}/{slot}'
                command[int(slot)] = file['prefix'] + '/inputs/' + path
                inputs.add(path, Path(file['path']).read_bytes())
        command[row['output_index']] = 'output.wasm'
        current = Path(row['output']).read_bytes()
        stages.append(dict(tool=row['binary'], args=command, sha256=digest(current)))
        rows.remove(row)
    return stages


def prepare(args, trace, version, cache):
    workspace = Workspace(args.workspace, cache, trace, args.compat, args.emsdk / 'upstream/emscripten')
    rows = [json.loads(path.read_text()) for path in sorted(trace.glob('*.json'))]
    output = args.output
    source = Bundle(output)
    libraries = Bundle(output)
    sdk_inputs = Bundle(output)
    player = Bundle(output)
    compilation, archives, links, post = [], {}, [], []
    source_paths = set()
    for row in rows:
        cwd = Path(row['cwd'])
        path = workspace.name(row['output']) if row['tool'] in ('compile', 'archive') else None
        if row['tool'] == 'compile':
            source_paths.add(row['source'])
            source_paths.update(json.loads(Path(row['dep']).read_text()))
            command = []
            flags = iter(workspace.arguments(row['args']))
            for arg in flags:
                if arg == '-MF':
                    next(flags)
                elif arg.startswith('-MF') or arg in ('-MD', '-MMD', '-MP'):
                    continue
                elif arg == '-o':
                    next(flags)
                elif arg.startswith('-o') and option(row['args'], '-o') == arg[2:]:
                    continue
                else:
                    command.append(arg)
            command += ['-o', '/' + path]
            source.add(workspace.name(cwd) + '/.willitwasm-cwd', b'')
            compilation.append(dict(args=command, cwd=workspace.name(cwd), path=path,
                                    source=workspace.name(row['source'])))
        elif row['tool'] == 'archive' and Path(row['output']).is_relative_to(args.workspace):
            if path in archives:
                raise ValueError(f'Archive was updated in several invocations: {path}')
            archives[path] = [workspace.name(member) for member in row['members']]
        elif row['tool'] == 'link':
            links.append(row)
        elif row['tool'] == 'post':
            post.append(row)
    for name in source_paths:
        source.add(workspace.name(name), Path(name).read_bytes())
    if not compilation or len(links) != 1:
        raise ValueError(f'Expected project compilation and one executable link, captured {len(compilation)} compilations and {len(links)} links.')
    if args.compat:
        source.add('sdk/cppgm_compat.h', args.compat.read_bytes())
    compile_outputs = {row['path'] for row in compilation}
    link = links[0]
    link_cwd = Path(link['cwd'])
    link_args = workspace.arguments(link['args'])
    raw = Path(link['raw']).read_bytes()
    compiler_tools = Path(args.emsdk) / 'upstream/bin'
    # Use LLD's own reproduction archive to identify every open file, including its temporary import list.
    with tarfile.open(link['reproduction']) as tar:
        response = next(item for item in tar if item.name.endswith('/response.txt'))
        prefix = response.name.rsplit('/', 1)[0] + '/'
        for item in tar:
            if not item.isfile() or not item.name.startswith(prefix):
                continue
            absolute_name = '/' + item.name.removeprefix(prefix)
            try:
                name = workspace.name(absolute_name)
            except ValueError:
                if Path(absolute_name).is_relative_to(compiler_tools):
                    raise ValueError(f'Unmapped compiler input: {absolute_name}') from None
                if item.name in (response.name, prefix + 'version.txt'):
                    continue
                raise
            if name not in compile_outputs and name not in archives:
                bundle = sdk_inputs if name.startswith('sdk/') else libraries
                bundle.add(name, tar.extractfile(item).read())
    entry = args.workspace / args.entry
    if not entry.is_file():
        raise ValueError(f'Web entry point missing: {entry}')
    wasm = entry.with_suffix('.wasm')
    if not wasm.is_file():
        raise ValueError(f'Expected {wasm.name} alongside {entry.name}')
    for path in sorted(entry.parent.iterdir()):
        if path.is_file() and path.suffix in ('.html', '.js', '.mjs', '.data', '.css', '.png', '.svg',
                                             '.json', '.woff2', '.webmanifest', '.ico', '.jpg', '.webp'):
            player.add(path.name, path.read_bytes())
    final = wasm.read_bytes()
    stages = post_link(post, raw, final, libraries)
    out_arg = option(link_args, '-o')
    if out_arg is None:
        raise ValueError('Missing linker output')
    for index, value in enumerate(link_args):
        if value == '-o':
            link_args[index + 1] = '/result/' + wasm.name
    write_json(output / 'plan.json', dict(schema='willitwasm/v1', kind='emscripten', repo=args.repo,
        commit=args.commit, sdk=version, epoch=int(EPOCH), entry=entry.name, output=wasm.name,
        compilation=sorted(compilation, key=lambda row: row['path']), archives=archives,
        link=dict(cwd=workspace.name(link_cwd), args=link_args, sha256=digest(raw)),
        post=stages, sha256=digest(final),
        source=source.write('source.bin'), libraries=libraries.write('libraries.bin'),
        sdkInputs=sdk_inputs.write('sdk.bin'),
        player=player.write('player.bin')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('workspace', 'output', 'emsdk', 'compiler', 'cache', 'config', 'compat'):
        parser.add_argument('--' + key, type=lambda value: Path(value).resolve(),
                            required=key in ('workspace', 'output', 'emsdk', 'compiler'))
    parser.add_argument('--repo', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--entry', required=True, help='HTML entry point relative to the workspace')
    parser.add_argument('--link-opt', choices=('-O0', '-O1', '-O2', '-O3'),
                        help='override optimization for a separate emcc link step')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] != ['--'] or len(args.command) < 2:
        parser.error('Supply the upstream build command after --')
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', args.repo) or args.repo.split('/')[1] in ('.', '..'):
        parser.error('--repo must identify a GitHub owner and project')
    if not (args.workspace / args.entry).resolve().is_relative_to(args.workspace) or not args.entry.endswith('.html'):
        parser.error('--entry must identify HTML inside the workspace')
    if not re.fullmatch(r'[a-f0-9]{40}', args.commit):
        parser.error('--commit must be a full commit hash')
    args.command = args.command[1:]
    args.output.mkdir(parents=True, exist_ok=True)
    trace = args.output / 'capture'
    trace.mkdir()
    version, cache = build(args, trace)
    prepare(args, trace, version, cache)
    print(f'Wrote {args.output / "plan.json"}')


if __name__ == '__main__':
    main()
