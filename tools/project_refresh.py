#!/usr/bin/env python3
"""Requalify frozen project inputs with a new published cppgm compiler."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from project_prepare import archive_bytes, digest, save


def refresh(template, reference, output, jobs):
    manifest = json.loads((template / 'manifest.json').read_text())
    output.mkdir(parents=True)
    inputs = output / 'inputs'
    for row in manifest['files']:
        source = template / 'inputs' / row['path']
        if digest(source.read_bytes()) != row['sha256']:
            raise ValueError('Frozen project input changed: ' + row['path'])
        target = inputs / row['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for directory in ['chunks', 'player', 'assets']:
        shutil.copytree(template / directory, output / directory)
    shutil.copyfile(template / 'transport.json', output / 'transport.json')
    environment = os.environ.copy()
    if 'source_date_epoch' in manifest:
        shim = output / 'frozen-time.so'
        subprocess.run(['cc', '-shared', '-fPIC', '-O2', str(Path(__file__).with_name('frozen_time.c')), '-o', str(shim)], check=True)
        environment.update(LD_PRELOAD=str(shim), TZ='UTC')
    compiler = reference / 'native-compiler'
    logs = output / 'logs'
    logs.mkdir()
    started = time.monotonic()

    def compile_one(row):
        (inputs / row['output']).parent.mkdir(parents=True, exist_ok=True)
        before = time.monotonic()
        result = subprocess.run([str(compiler), *row['args']], cwd=inputs, capture_output=True, timeout=1200, env=environment)
        (logs / (Path(row['output']).name + '.log')).write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError(row['source'] + ': ' + result.stderr.decode(errors='replace')[-2000:])
        row.update(sha256=digest((inputs / row['output']).read_bytes()), seconds=time.monotonic()-before)
        row.pop('native_sha256', None)
        row.pop('reused', None)

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(compile_one, row) for row in manifest['commands']]
        for count, future in enumerate(as_completed(futures), 1):
            future.result()
            if count % 200 == 0:
                print(manifest['id'], 'native', count, flush=True)
    for row in manifest['archives']:
        path = inputs / row['output']
        path.parent.mkdir(parents=True, exist_ok=True)
        data = archive_bytes(row['members'], inputs)
        path.write_bytes(data)
        row['sha256'] = digest(data)
    result = subprocess.run([str(compiler), *manifest['link']['args']], cwd=inputs, capture_output=True, timeout=1200, env=environment)
    (logs / 'link.log').write_bytes(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-2500:])
    manifest['link']['sha256'] = digest((inputs / manifest['link']['output']).read_bytes())
    manifest['link'].pop('native_sha256', None)
    manifest.pop('reference_runtime', None)
    manifest['compiler_manifest'] = digest((reference / 'manifest.json').read_bytes())
    save(output / 'manifest.json', manifest)
    (output / 'manifest.sha256').write_text(digest((output / 'manifest.json').read_bytes()) + '\n')
    save(output / 'native-complete.json', dict(seconds=time.monotonic()-started, units=len(manifest['commands']), compiler_sha256=digest(compiler.read_bytes())))
    print('Frozen project requalified:', manifest['id'], flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['template', 'reference', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=8)
    args = parser.parse_args()
    refresh(args.template.resolve(), args.reference.resolve(), args.output.resolve(), args.jobs)
