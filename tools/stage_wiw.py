#!/usr/bin/env python3
"""Add a staged Will it Wasm site to an incpption Pages upload."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

SHARED = {'compiler', 'clang-seed', 'projects', 'vendor', 'shim', 'licenses', 'wasi_demo.css'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', type=Path, help='staged incpption Pages site')
    parser.add_argument('wiw', type=Path, help='Will it Wasm dist built with --shared-root')
    options = parser.parse_args()
    site, wiw = options.site, options.wiw
    config = json.loads((wiw / 'settings.json').read_text())
    if config.get('sharedAssets') != '/' or not config.get('wasiProbeBytes'):
        raise ValueError('Stage Will it Wasm with --shared-root and --wasi-probe')
    if any(not (site / name).exists() for name in SHARED):
        raise ValueError('The incpption site is missing shared assets')
    target = site / 'wiw'
    target.mkdir(exist_ok=True)
    for source in sorted(wiw.iterdir()):
        if source.name in SHARED:
            continue
        dest = target / source.name
        if source.is_dir():
            shutil.copytree(source, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(source, dest)
    preview = (target / 'share.png').read_bytes()
    preview_name = f'assets/wiw-share.{hashlib.sha256(preview).hexdigest()[:16]}.png'
    (site / preview_name).write_bytes(preview)
    page = target / 'index.html'
    page.write_text(page.read_text().replace('https://incpption.com/wiw/share.png',
                                            'https://incpption.com/' + preview_name))
    excessive = [str(file.relative_to(target)) for file in target.rglob('*')
                 if file.is_file() and file.stat().st_size > 25 * 1024 * 1024]
    if excessive:
        raise ValueError('Pages assets over 25 MiB: ' + ', '.join(excessive))

    index = site / 'index.html'
    html = index.read_text()
    label = '<a href="/wiw/">Will it Wasm?</a>'
    anchor = '<nav aria-label="Page"><a href="#workflow">Build</a>'
    if label not in html:
        if html.count(anchor) != 1:
            raise ValueError('The incpption navigation changed')
        index.write_text(html.replace(anchor, anchor + label))

    (site / '_routes.json').write_text(json.dumps({
        'version': 1, 'include': ['/wiw/api/archive'], 'exclude': []
    }) + '\n')
    redirect = site / '_redirects'
    lines = redirect.read_text().splitlines() if redirect.exists() else []
    rule = '/wiw /wiw/ 302'
    if rule not in lines:
        redirect.write_text('\n'.join([*lines, rule]) + '\n')
    print(f'Staged {target}')


if __name__ == '__main__':
    main()
