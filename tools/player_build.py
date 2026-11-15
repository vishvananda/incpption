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
for name in ['game_frame.html', 'game_frame.mjs', 'openlara_play.mjs', 'doom_play.mjs', 'godot_play.mjs', 'blob_parts.mjs', 'asset_cache.mjs', 'transport_bytes.mjs', 'game_exports.mjs', 'game_controls.mjs', 'game_controls.css', '_headers']:
    shutil.copyfile(args.site / name, args.output / name)
shutil.copytree(args.site / 'assets', args.output / 'assets',
                ignore=lambda directory, names: [name for name in names if not name.startswith('game_controls.')])
for path in (args.site/'projects').glob('*/player'):
    target=args.output/'projects'/path.parent.name/'player';target.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(path,target)
headers = (args.output / '_headers').read_text().replace(
    'Cross-Origin-Embedder-Policy: require-corp',
    'Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: cross-origin')
(args.output / '_headers').write_text(headers)
shutil.copytree(args.site / 'licenses', args.output / 'licenses')
shutil.copyfile(args.site / 'site-release.json', args.output / 'player-release.json')
(args.output / 'index.html').write_text('<!doctype html><meta http-equiv="refresh" content="0;url=https://incpption.com/"><a href="https://incpption.com/">cppgm inception</a>')
print('Built isolated static player:', args.output)
