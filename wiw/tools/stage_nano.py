"""Stage a pinned NanoVM runtime and its GNU Make guest tool."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

PIN = Path(__file__).resolve().parents[1] / 'config/nanovm.json'


def stage_nano(site, source, wasm, make, make_source):
    pin = json.loads(PIN.read_text())
    revision = pin['revision']
    runtime = f'nano/{revision}'
    destination = site / runtime
    destination.mkdir(parents=True, exist_ok=True)
    tracked = subprocess.check_output([
        'git', '-C', source, 'archive', '--format=tar', revision, 'LICENSE', 'LICENSE.md', 'NOTICE',
        'kernel', 'runners/riscv/host', 'runners/wasm/src',
    ])
    with tarfile.open(fileobj=io.BytesIO(tracked)) as bundle:
        for row in bundle:
            parts = Path(row.name).parts
            if not row.isfile() or 'test' in parts or (len(parts) > 1 and not row.name.endswith('.mjs')):
                continue
            output = destination / row.name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(bundle.extractfile(row).read())

    def verified(path, expected, label):
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f'{label} does not match the NanoVM input pin')
        return data

    def asset(name, data):
        path = destination / name
        path.write_bytes(gzip.compress(data, compresslevel=6, mtime=0))
        return path.stat().st_size

    wasm_data = verified(wasm, pin['wasmSha256'], 'NanoVM Wasm')
    make_data = verified(make, pin['makeSha256'], 'GNU Make ELF')
    make_archive = verified(make_source, pin['makeSourceSha256'], 'GNU Make source')
    (destination / 'make-4.4.1.tar.gz').write_bytes(make_archive)
    with tarfile.open(fileobj=io.BytesIO(make_archive)) as bundle:
        (destination / 'MAKE-COPYING').write_bytes(bundle.extractfile('make-4.4.1/COPYING').read())
    (destination / 'SOURCES.txt').write_text(
        f'NanoVM source: https://github.com/vishvananda/nano/tree/{revision}\n'
        'BusyBox 1.36.1: https://busybox.net/downloads/busybox-1.36.1.tar.bz2\n'
        'GNU Make 4.4.1: make-4.4.1.tar.gz\n'
        'GNU Make build: CC=riscv64-linux-musl-gcc LDFLAGS="-static -no-pie" '
        './configure --host=riscv64-linux-musl --build=x86_64-linux-gnu --disable-nls\n'
        'Then make and strip with riscv64-linux-musl-strip.\n')
    size = asset('runtime.bin', wasm_data) + asset('make.bin', make_data)
    return {**pin, 'root': runtime + '/', 'encodedBytes': size}
