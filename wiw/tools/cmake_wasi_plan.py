#!/usr/bin/env python3
"""Export a single configured WASI CMake target as a Will it Wasm plan."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess


GENERATED = '.willitwasm-generated/'


def require_inside(path, root):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        raise ValueError(f'Input is outside the configured source, build, and SDK: {path}') from None


def compile_argv(row, source, cwd):
    args = list(row['arguments'] if 'arguments' in row else shlex.split(row['command']))
    compiler = Path(args.pop(0)).resolve()
    result = []
    values = iter(args)
    for arg in values:
        if arg in ('-o', '-MT', '-MF', '-MQ'):
            next(values)
        elif arg in ('-c', '-MD', '-MMD'):
            continue
        elif arg.startswith('-') or (cwd / arg).resolve() != source:
            result.append(arg)
    return compiler, result


def portable_flags(args, source, build, sdk, cwd):
    def translate(value):
        path = (cwd / value).resolve()
        if path.is_relative_to(source):
            return 'checkout/' + path.relative_to(source).as_posix()
        if path.is_relative_to(build):
            relative = path.relative_to(build).as_posix()
            return 'checkout/' + GENERATED + ('' if relative == '.' else relative)
        if path.is_relative_to(sdk / 'share/wasi-sysroot'):
            return 'sysroot/' + require_inside(path, sdk / 'share/wasi-sysroot')
        raise ValueError(f'Unsupported include path for the portable plan: {path}')

    result = []
    values = iter(args)
    for arg in values:
        if arg in ('--sysroot', '--target', '-target', '-resource-dir'):
            next(values)
        elif arg.startswith(('--sysroot=', '--target=', '-resource-dir=')):
            continue
        elif arg in ('-I', '-isystem', '-iquote', '-include', '-imacros'):
            result += [arg, translate(next(values))]
        elif arg.startswith('-I') and len(arg) > 2:
            result.append('-I' + translate(arg[2:]))
        elif arg.startswith('-W'):
            continue
        elif arg.startswith('-'):
            result.append(arg)
        else:
            raise ValueError(f'Unsupported standalone compiler argument: {arg}')
    return result


def dependencies(compiler, flags, source, cwd):
    result = subprocess.run([compiler, *flags, '-M', '-MT', 'input', source],
                            cwd=cwd, check=True, capture_output=True, text=True)
    _, dependencies = result.stdout.replace('\\\n', ' ').split(':', 1)
    return {(cwd / name).resolve() for name in shlex.split(dependencies)}


def capture(source, build, sdk, target, repo, commit, exports, output):
    rows = json.loads((build / 'compile_commands.json').read_text())
    marker = f'CMakeFiles/{target}.dir/'
    rows = [row for row in rows if marker in row.get('output', row.get('command', ''))]
    if not rows:
        raise ValueError(f'No compile commands for target {target}')
    sources, files, generated, flags = [], set(), {}, None
    for row in rows:
        cwd = Path(row['directory']).resolve()
        path = (cwd / row['file']).resolve()
        sources.append(require_inside(path, source))
        compiler, args = compile_argv(row, path, cwd)
        require_inside(compiler, sdk)
        portable = portable_flags(args, source, build, sdk, cwd)
        if flags is not None and portable != flags:
            raise ValueError('This plan format requires a common set of compile flags.')
        flags = portable
        for dependency in dependencies(compiler, args, path, cwd):
            if dependency == path:
                continue
            if dependency.is_relative_to(source):
                files.add(require_inside(dependency, source))
            elif dependency.is_relative_to(build):
                generated[GENERATED + require_inside(dependency, build)] = dependency.read_text()
            elif not dependency.is_relative_to(sdk):
                raise ValueError(f'External dependency needs a portable SDK: {dependency}')
    link = ['-nostartfiles', *('--export=' + name for name in exports)] if exports else []
    return {
        'schema': 'willitwasm/v1', 'kind': 'wasi', 'repo': repo, 'commit': commit,
        'sources': sources, 'files': sorted(files - set(sources)), 'generated': generated,
        'compileFlags': flags, 'linkFlags': link, 'output': output,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'build', 'sdk'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('target', 'repo', 'commit', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--export', action='append', default=[])
    options = parser.parse_args()
    plan = capture(options.source.resolve(), options.build.resolve(), options.sdk.resolve(),
                   options.target, options.repo, options.commit, options.export, options.output)
    print(json.dumps(plan, indent=2))


if __name__ == '__main__':
    main()
