#!/usr/bin/env python3
"""Check source syntax and the artifact lock without downloading build data."""
import ast
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

for path in sorted((ROOT / 'tools').glob('*.py')):
    ast.parse(path.read_text(), filename=str(path))
for directory, suffix in [('web', '*.mjs'), ('tests', '*.cjs')]:
    for path in sorted((ROOT / directory).rglob(suffix)):
        subprocess.run(['node', '--check', str(path)], check=True)
config = json.loads((ROOT / 'site.json').read_text())
lock = json.loads((ROOT / config['artifact_lock']).read_text())
paths = set()
for row in lock['files']:
    path = Path(row['path'])
    if path.is_absolute() or '..' in path.parts or row['path'] in paths:
        raise RuntimeError('invalid or duplicate artifact path: ' + row['path'])
    paths.add(row['path'])
    if len(row['sha256']) != 64 or any(c not in '0123456789abcdef' for c in row['sha256']):
        raise RuntimeError('invalid artifact SHA-256: ' + row['path'])
print('Source syntax and artifact lock passed')
