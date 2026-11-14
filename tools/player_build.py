#!/usr/bin/env python3
"""Extract the static player into its own origin; game bytes arrive locally."""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--site', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
for name in ['game_frame.html', 'game_frame.mjs', 'openlara_play.mjs', 'game_controls.mjs', 'game_controls.css', '_headers']:
    shutil.copyfile(args.site / name, args.output / name)
shutil.copytree(args.site / 'assets', args.output / 'assets',
                ignore=lambda directory, names: [name for name in names if not name.startswith('game_controls.')])
(args.output / 'game').mkdir()
for path in (args.site / 'game').glob('runtime.*.mjs'):
    shutil.copyfile(path, args.output / 'game' / path.name)
headers = (args.output / '_headers').read_text().replace(
    'Cross-Origin-Embedder-Policy: require-corp',
    'Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: cross-origin')
(args.output / '_headers').write_text(headers)
shutil.copytree(args.site / 'licenses', args.output / 'licenses')
shutil.copyfile(args.site / 'site-release.json', args.output / 'player-release.json')
(args.output / 'index.html').write_text('<!doctype html><meta http-equiv="refresh" content="0;url=https://incpption.com/"><a href="https://incpption.com/">cpp inception</a>')
print('Built isolated static player:', args.output)
