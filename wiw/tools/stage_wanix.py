"""Stage one Wanix Linux guest with the WIW build tools and compiler relay."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ('cc', 'gcc', 'clang', 'cppgm', 'c++', 'g++', 'clang++', 'ar', 'ranlib')
SKIP = {'usr/bin/cpack', 'usr/bin/ctest'}
IMAGE_CHUNK = 16 * 1024 * 1024


def verified(path, expected):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'{path.name} does not match the Wanix input pin')
    return io.BytesIO(data)


def entry(bundle, name, data=b'', *, mode=0o644, kind=tarfile.REGTYPE, link=''):
    row = tarfile.TarInfo(name)
    row.mode, row.type, row.linkname, row.size = mode, kind, link, len(data)
    bundle.addfile(row, io.BytesIO(data))


def kernel(source, pin):
    with tempfile.TemporaryDirectory(prefix='wiw-wanix-') as temporary:
        build = Path(temporary)
        with subprocess.Popen(['git', '-C', source, 'archive', pin['revision']], stdout=subprocess.PIPE) as process:
            with tarfile.open(fileobj=process.stdout, mode='r|') as bundle:
                bundle.extractall(build, filter='data')
            if process.wait():
                raise ValueError('Could not export the pinned Wanix source')
        subprocess.run(['git', 'apply', ROOT / 'guest/wanix/guest-filesystem.patch'],
                       cwd=build, check=True)
        binary = build / 'wiw.wasm'
        subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w',
                        '-o', binary, './wasm'], cwd=build, check=True,
                       env={**os.environ, 'GOOS':'js', 'GOARCH':'wasm', 'GOTOOLCHAIN':pin['goVersion']})
        return gzip.compress(binary.read_bytes(), compresslevel=6, mtime=0)


def package_files(directory, pins):
    files = {}
    for name, spec in pins.items():
        with tarfile.open(fileobj=verified(directory / name, spec['sha256'])) as bundle:
            for row in bundle:
                if row.name in SKIP or row.name.startswith(('.', 'usr/share/doc/', 'usr/share/man/')):
                    continue
                if row.isfile() or row.issym() or row.isdir():
                    row.pax_headers.pop('APK-TOOLS.checksum.SHA1', None)
                    files[row.name] = (row, bundle.extractfile(row).read() if row.isfile() else b'')
    return files


def workspace_tool(source, pin):
    with tempfile.TemporaryDirectory(prefix='wiw-wanix-workspace-') as temporary:
        binary = Path(temporary) / 'workspace'
        subprocess.run(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', binary, source],
                       check=True, env={**os.environ, 'GOOS':'linux', 'GOARCH':'386', 'CGO_ENABLED':'0',
                                        'GOTOOLCHAIN':pin['goVersion']})
        return binary.read_bytes()


def stage_wanix(site, source, runtime, extras, make, apks):
    pin = json.loads((ROOT / 'config/wanix.json').read_text())
    packages = pin['packages']
    assets = {}
    with tarfile.open(fileobj=verified(runtime, packages['wanix'])) as bundle:
        assets['wanix.min.js'] = bundle.extractfile('package/dist/wanix.min.js').read()
        assets['LICENSE'] = bundle.extractfile('package/LICENSE').read()
    with tarfile.open(fileobj=verified(extras, packages['wanix-extras'])) as bundle:
        image = io.BytesIO(bundle.extractfile('package/dist/wanix-linux.tgz').read())
        assets['v86.tgz'] = bundle.extractfile('package/dist/v86.tgz').read()
    with tarfile.open(fileobj=verified(make, packages['make'])) as bundle:
        make_elf = bundle.extractfile('usr/bin/make').read()

    guest = ROOT / 'guest/wanix'
    packages = package_files(apks, pin['alpinePackages'])
    workspace = workspace_tool(guest / 'workspace.go', pin)
    assets['kernel.bin'] = kernel(source, pin)
    assets['guest-filesystem.patch'] = (guest / 'guest-filesystem.patch').read_bytes()
    linux = io.BytesIO()
    with gzip.GzipFile(fileobj=linux, mode='wb', compresslevel=6, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|') as output, tarfile.open(fileobj=image) as base:
            for row in base:
                if row.name.removeprefix('./') not in packages:
                    output.addfile(row, base.extractfile(row) if row.isfile() else None)
            for row, data in packages.values():
                output.addfile(row, io.BytesIO(data) if row.isfile() else None)
            entry(output, './usr/bin/ninja', kind=tarfile.SYMTYPE, link='../lib/ninja-build/bin/ninja')
            entry(output, './boot/rc', (guest / 'boot.sh').read_bytes(), mode=0o755)
            entry(output, './usr/bin/make', make_elf, mode=0o755)
            entry(output, './wiw', mode=0o755, kind=tarfile.DIRTYPE)
            entry(output, './wiw/tool', (guest / 'tool.sh').read_bytes(), mode=0o755)
            entry(output, './wiw/workspace', workspace, mode=0o755)
            entry(output, './wiw/Platform', mode=0o755, kind=tarfile.DIRTYPE)
            for name in ('wasi_toolchain.cmake', 'WASI.cmake'):
                path = 'Platform/' + name if name == 'WASI.cmake' else name
                entry(output, './wiw/' + path, (ROOT / 'guest' / name).read_bytes())
            for path in sorted(guest.glob('*.cmake')):
                entry(output, './wiw/' + path.name, path.read_bytes())
            for name in TOOLS:
                entry(output, './usr/bin/' + name, kind=tarfile.SYMTYPE, link='/wiw/tool')
    image = linux.getvalue()
    chunks = []
    for offset in range(0, len(image), IMAGE_CHUNK):
        name = f'linux.{len(chunks):04d}.bin'
        chunks.append(name)
        assets[name] = image[offset:offset + IMAGE_CHUNK]
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in assets.items()}
    revision = hashlib.sha256(''.join(hashes.values()).encode()).hexdigest()[:16]
    root = 'wanix/' + revision + '/'
    dest = site / root
    dest.mkdir(parents=True, exist_ok=True)
    for name, data in assets.items():
        (dest / name).write_bytes(data)
    (dest / 'SOURCES.txt').write_text(
        f"Wanix {pin['version']}: https://github.com/tractordev/wanix/tree/{pin['revision']}\n"
        f"WIW kernel: Apply guest-filesystem.patch and build ./wasm for js/wasm with {pin['goVersion']}.\n"
        f"Published runtime: https://registry.npmjs.org/wanix/-/wanix-{pin['version']}.tgz\n"
        f"Linux and v86: https://registry.npmjs.org/wanix-extras/-/wanix-extras-{pin['version']}.tgz\n"
        'Upstream guest build and kernel configuration: https://github.com/tractordev/wanix/tree/dd17950e1d67d51c0b65d81d2597e0507ac67b89/extras\n'
        'v86: https://github.com/copy/v86\n'
        'GNU Make 4.4.1-r3 (GPL-3.0-or-later): https://gitlab.alpinelinux.org/alpine/aports/-/tree/be0833caee3020f089f02c5d7223e971a9a11ffb/main/make\n'
        'GNU Make upstream source: https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz\n'
        'Additional packages and source recipes: https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.22-stable\n'
        + ''.join(f'https://dl-cdn.alpinelinux.org/alpine/v3.22/{row["repo"]}/x86/{name}\n'
                  for name, row in pin['alpinePackages'].items()))
    downloads = ('wanix.min.js', 'kernel.bin', 'v86.tgz', *chunks)
    return {'root':root, 'chunks':chunks, 'encodedBytes':sum(len(assets[name]) for name in downloads),
            'sha256':hashes}
