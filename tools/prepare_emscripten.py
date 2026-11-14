#!/usr/bin/env python3
"""Prepare a private Emscripten 4.0.9 ABI1 profile for cppgm experiments."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--emsdk', required=True, type=Path)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--jobs', type=int, default=8)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error('--jobs must be positive')
    emsdk, directory = args.emsdk.resolve(), args.directory.resolve()
    source = emsdk / 'upstream/emscripten'
    version = (source / 'emscripten-version.txt').read_text().strip().strip('"')
    if version != '4.0.9':
        raise RuntimeError('this profile requires Emscripten 4.0.9')
    if directory.exists():
        raise RuntimeError('use a new profile directory; existing observations are never replaced')
    node = shutil.which(args.node)
    if node is None:
        raise RuntimeError('Node executable not found')
    directory.mkdir(parents=True)
    private = directory / 'emscripten'
    shutil.copytree(source, private)
    patches = []

    def patch(name, replacements):
        path = private / name
        before = sha(path)
        text = path.read_text()
        for original, replacement in replacements:
            if text.count(original) != 1:
                raise RuntimeError(f'expected exactly one occurrence in {name}: {original}')
            text = text.replace(original, replacement)
        path.write_text(text)
        patches.append(dict(path=name, before=before, after=sha(path)))

    for name in ['system/lib/libcxx/include/__config_site', 'cache/sysroot/include/c++/v1/__config_site']:
        patch(name, [('#define _LIBCPP_ABI_VERSION 2', '#define _LIBCPP_ABI_VERSION 1'),
                     ('#define _LIBCPP_ABI_NAMESPACE __2', '#define _LIBCPP_ABI_NAMESPACE __1')])
    deprecated = []
    for replacement in ['emscripten_set_canvas_element_size() instead',
                        'emscripten_get_canvas_element_size() and emscripten_get_fullscreen_status() instead']:
        deprecated.append(('"This variant does not allow specifying the target canvas", "Use ' + replacement + '"',
                           '"This variant does not allow specifying the target canvas. Use ' + replacement + '"'))
    for name in ['system/include/emscripten/emscripten.h', 'cache/sysroot/include/emscripten/emscripten.h']:
        patch(name, deprecated)
    # Musl's internal visibility macro collides with this public member. Keep
    # its public layout intact while building libc with internal headers first.
    event = ('typedef struct EmscriptenVisibilityChangeEvent {\n'
             '  bool hidden;\n  int visibilityState;\n'
             '} EmscriptenVisibilityChangeEvent;')
    guarded_event = ('#ifdef hidden\n#define CPPGM_RESTORE_MUSL_HIDDEN 1\n#undef hidden\n#endif\n'
                     + event + '\n#ifdef CPPGM_RESTORE_MUSL_HIDDEN\n'
                     '#define hidden __attribute__((__visibility__("hidden")))\n'
                     '#undef CPPGM_RESTORE_MUSL_HIDDEN\n#endif')
    for name in ['system/include/emscripten/html5.h', 'cache/sysroot/include/emscripten/html5.h']:
        patch(name, [(event, guarded_event)])
    # Cached ABI2 archives cannot accompany the ABI1 headers. Other variants
    # can subsequently be rebuilt by emcc from the patched private sources.
    library_root = private / 'cache/sysroot/lib/wasm32-emscripten'
    for archive in library_root.glob('libc++*.a'):
        archive.unlink()
    config = directory / 'emconfig'
    config.write_text(f'NODE_JS = {str(Path(node).resolve())!r}\n'
                      f'LLVM_ROOT = {str(emsdk / "upstream/bin")!r}\n'
                      f'BINARYEN_ROOT = {str(emsdk / "upstream")!r}\n'
                      f'CACHE = {str(private / "cache")!r}\n')
    compatibility = directory / 'cppgm_compat.h'
    compatibility.write_text('#if defined(__cplusplus) && !defined(__clang__)\n'
                             '#ifndef _Noreturn\n#define _Noreturn __attribute__((__noreturn__))\n'
                             '#endif\n#endif\n')
    environment = dict(os.environ, EM_CONFIG=str(config), EMCC_CORES=str(args.jobs))
    started = time.monotonic()
    command = ['python3', str(private / 'embuilder.py'), '--force', 'build', 'libc++-noexcept', 'libc++abi-noexcept']
    with (directory / 'runtime-build.log').open('wb') as log:
        subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    flags = ['--target=wasm32-unknown-emscripten', '--sysroot=emscripten/cache/sysroot',
             '-isystem', 'emscripten/cache/sysroot/include/compat', '-include', 'cppgm_compat.h',
             '-std=gnu++17', '-fno-exceptions', '-O3', '-D__EMSCRIPTEN__=1',
             '-D__EMSCRIPTEN_major__=4', '-D__EMSCRIPTEN_minor__=0', '-D__EMSCRIPTEN_tiny__=9',
             '-D__GNUC__=4', '-D__GNUC_MINOR__=2', '-D__GNUC_PATCHLEVEL__=1', '-D__GNUG__=4',
             '-D__GXX_ABI_VERSION=1002', '-D_GNU_SOURCE=1', '-D__unix__=1', '-D__unix=1', '-Dunix=1']
    manifest = dict(schema=1, emscripten_version=version, abi=1, exceptions=False, threads=False,
                    patches=patches, compiler_flags=flags, compatibility_sha256=sha(compatibility),
                    runtime_seconds=time.monotonic() - started, command=command,
                    runtime={name: sha(library_root / name) for name in ['libc++-noexcept.a', 'libc++abi-noexcept.a']})
    (directory / 'profile.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared {directory}; runtime rebuild {manifest["runtime_seconds"]:.2f}s')


if __name__ == '__main__':
    main()
