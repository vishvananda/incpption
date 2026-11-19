#!/usr/bin/env python3
"""Split the Godot editor's generated documentation translations for Wasm replay."""
import argparse
from pathlib import Path
import re

# Adapted from incpption/tools/translation_profile.py.
ARRAY = re.compile(r'(inline constexpr const unsigned char (_doc_translation_(\w+)_compressed)\[\] = )'
                   r'\{\s*([\d,\s]+)\};')
ESCAPES = tuple(f'\\x{value:02x}' for value in range(256))


def prepare(workspace):
    relative = 'editor/translations/doc_translations.gen.cpp'
    file = workspace / relative
    header = file.with_suffix('.h')
    original = file.read_text()
    if not header.is_file():
        raise ValueError('Generate the doc translations with SCons first')
    builder = workspace / 'editor/SCsub'
    script = builder.read_text()
    old = '        "#' + relative + '": Glob("#doc/translations/*"),\n'
    anchor = '    env.add_source_files(env.editor_sources, translation_targets.keys())\n'
    if script.count(old) != 1 or script.count(anchor) != 1:
        raise ValueError('The upstream SCons translation rule changed')
    first = ARRAY.search(original)
    if not first:
        raise ValueError('The generated Godot translation format changed')

    prefix = original[:first.start()]
    parts = {}

    def split(match):
        values = (int(number.group()) for number in re.finditer(r'\d+', match[4]))
        data = ''.join(ESCAPES[value] for value in values)
        symbol, locale = match[2], match[3]
        parts[file.parent / ('doc_translation_' + locale + '.gen.cpp')] = (
            prefix + f'extern const unsigned char {symbol}[] = "{data}";\n')
        return f'extern const unsigned char {symbol}[];'

    table = ARRAY.sub(split, original)
    for part, source in parts.items():
        part.write_text(source)
    file.write_text(table)
    sources = ['#' + relative, *('#' + part.relative_to(workspace).as_posix() for part in sorted(parts))]
    builder.write_text(script.replace(old, '').replace(anchor,
        anchor + f'    env.add_source_files(env.editor_sources, {sources!r})\n'))
    print(f'Split {len(parts)} documentation translations in {workspace}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace', type=Path)
    prepare(parser.parse_args().workspace.resolve())
