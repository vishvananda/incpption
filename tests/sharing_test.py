#!/usr/bin/env python3
"""Check the static metadata and actual image bytes seen by preview crawlers."""
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import struct
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1] if len(sys.argv) > 1 else 'dist')
config = json.loads((ROOT / 'site.json').read_text())


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self.icons = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            self.meta[attrs.get('property', attrs.get('name'))] = attrs.get('content')
        if tag == 'link' and attrs.get('rel') in ['icon', 'apple-touch-icon']:
            self.icons[attrs['rel']] = attrs['href']


def image(url, dimensions):
    parsed = urlsplit(url)
    assert parsed.scheme == 'https' and parsed.netloc == config['domain'], url
    file = output / parsed.path.lstrip('/')
    assert file.resolve().is_relative_to(output.resolve()), url
    data = file.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR'
    assert struct.unpack('>II', data[16:24]) == dimensions
    assert len(data) < 5 * 1024 * 1024
    assert hashlib.sha256(data).hexdigest()[:16] in file.name, 'Image URL must change with its bytes'


for name in ['index.html', 'wasi_demo.html']:
    raw = (output / name).read_bytes()
    # Messages reads a bounded page without executing JavaScript.
    assert len(raw) < 1024 * 1024
    head = Head()
    head.feed(raw.decode())
    for field in ['description', 'og:description', 'twitter:description']:
        assert head.meta[field] == config['description']
        assert config['project_prompt'] not in head.meta[field]
    for field in ['og:title', 'og:type', 'og:url', 'og:site_name']:
        assert head.meta[field]
    assert head.meta['twitter:card'] == 'summary_large_image'
    assert head.meta['og:image'] == head.meta['og:image:secure_url'] == head.meta['twitter:image']
    assert head.meta['og:image:type'] == 'image/png'
    assert (head.meta['og:image:width'], head.meta['og:image:height']) == ('1200', '630')
    assert head.meta['og:image:alt'] and head.meta['twitter:image:alt']
    image(head.meta['og:image'], (1200, 630))
    assert head.icons['icon'] == head.icons['apple-touch-icon']
    image(head.icons['apple-touch-icon'], (256, 256))
assert (output / 'robots.txt').read_text().strip() == 'User-agent: *\nAllow: /'
print('PASS: static sharing descriptions, absolute image URLs, real PNG sizes, cache identities and icons')
