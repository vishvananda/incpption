#!/usr/bin/env python3
"""Replay a recorded compiler plan in a fresh copy of the capture SDK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

from capture import ROOT, TOOLS, sdk_version


def unpack_workspace(archive):
    with tarfile.open(archive) as bundle:
        plan = json.load(bundle.extractfile('plan.json'))
        if plan['schema'] != 1 or plan['target'] != 'x86_64-linux-musl':
            raise ValueError('Unsupported build-plan format or target')
        if plan.get('sdk') != sdk_version():
            raise ValueError('This plan requires the capture SDK')
        workspace = ROOT / plan['project']['id']
        if workspace != Path(plan['workspace']) or workspace.parent != ROOT:
            raise ValueError('Invalid workspace')
        workspace.mkdir(parents=True)
        bundle.extractall(workspace, filter='data',
                          members=[item for item in bundle if item.name.startswith('workspace/')])
    inputs = workspace / 'workspace'
    for path in inputs.iterdir():
        path.rename(workspace / path.name)
    inputs.rmdir()
    for product in plan['products']:
        (workspace / product['path']).parent.mkdir(parents=True, exist_ok=True)
    return plan, workspace


def replay(archive, references):
    start = time.monotonic()
    plan, workspace = unpack_workspace(archive)
    env = {**os.environ, **plan['environment']}
    for action in plan['actions']:
        cwd = Path(action['cwd'])
        if not cwd.is_relative_to(workspace):
            raise ValueError(f'Command working directory escaped workspace: {cwd}')
        cwd.mkdir(parents=True, exist_ok=True)
        subprocess.run(['/usr/bin/' + TOOLS[action['tool']], *action['args']],
                       cwd=cwd, env=env, check=True)
    expected = {item['path']: item['sha256'] for item in plan['products']}
    if references:
        with tarfile.open(references / archive.name) as reference:
            full_build = json.load(reference.extractfile('plan.json'))
        if full_build['project']['sha256'] != plan['project']['sha256'] or full_build['sdk'] != plan['sdk']:
            raise ValueError('Reference source or SDK differs')
        expected = {item['path']: item['sha256'] for item in full_build['products']}
    missing = []
    differing = []
    for name, digest in expected.items():
        path = workspace / name
        if not path.is_file():
            missing.append(name)
        elif digest and hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            differing.append(name)
    return {'id': plan['project']['id'], 'seconds': round(time.monotonic() - start, 2),
            'products': len(expected), 'checksums': sum(bool(value) for value in expected.values()),
            'missing': missing, 'differing': differing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--references', type=Path)
    parser.add_argument('bundles', nargs='+', type=Path)
    args = parser.parse_args()
    results = []
    for bundle in args.bundles:
        try:
            result = replay(bundle, args.references)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            result = {'id': bundle.name.removesuffix('.tar.gz'), 'error': str(error)}
        results.append(result)
        print(json.dumps(result), flush=True)
    return any(result.get('error') or result['missing'] or result['differing'] for result in results)


if __name__ == '__main__':
    raise SystemExit(main())
