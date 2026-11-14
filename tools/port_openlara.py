#!/usr/bin/env python3
"""Copy the pinned OpenLara source and apply the small SDK 4.0.9 web port."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REVISION = '3b268ca4bf986c380f44a26ffd9218bf6d376249'


def escape_legacy_literals(data):
    """Preserve every legacy string byte using octal C++ escapes, not UTF-8."""
    out = bytearray()
    i = 0
    while i < len(data):
        if data[i:i + 2] in (b'//', b'/*'):
            end = data.find(b'\n', i) if data[i:i + 2] == b'//' else data.find(b'*/', i) + 2
            if end < i:
                end = len(data)
            out.extend(data[i:end])
            i = end
        elif data[i] in (34, 39):
            quote = data[i]
            out.append(quote)
            i += 1
            while i < len(data):
                byte = data[i]
                if byte == 92:
                    out.extend(data[i:i + 2])
                    i += 2
                    continue
                out.extend(('\\%03o' % byte).encode() if byte >= 128 else bytes([byte]))
                i += 1
                if byte == quote:
                    break
        else:
            out.append(data[i])
            i += 1
    return bytes(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='clean pinned upstream checkout')
    parser.add_argument('--output', required=True, type=Path, help='new directory')
    args = parser.parse_args()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.source, text=True).strip()
    if revision != REVISION or subprocess.check_output(['git', 'status', '--porcelain'], cwd=args.source):
        raise RuntimeError(f'expected clean OpenLara {REVISION}')
    args.output.mkdir()
    shutil.copytree(args.source / 'src', args.output / 'src')
    for name in ['LICENSE', 'README.md']:
        shutil.copyfile(args.source / name, args.output / name)
    changes = []

    def write(name, data):
        path = args.output / 'src' / name
        before = path.read_bytes()
        path.write_bytes(data)
        changes.append(dict(path=name, before=hashlib.sha256(before).hexdigest(), after=hashlib.sha256(data).hexdigest()))

    for name in ['lang.h', 'lang/ru.h', 'ui.h']:
        write(name, escape_legacy_literals((args.output / 'src' / name).read_bytes()))
    name = 'platform/web/main.cpp'
    text = (args.output / 'src' / name).read_text()
    replacements = [
        ('void joyUpdate() {', 'void joyUpdate() {\n    if (emscripten_sample_gamepad_data() != EMSCRIPTEN_RESULT_SUCCESS) return;'),
        ('emscripten_webgl_create_context(0, &attrs)', 'emscripten_webgl_create_context("#canvas", &attrs)'),
        ('emscripten_get_element_css_size(NULL, &w, &h)', 'emscripten_get_element_css_size("#canvas", &w, &h)'),
        ('emscripten_set_canvas_size(Core::width, Core::height)', 'emscripten_set_canvas_element_size("#canvas", Core::width, Core::height)'),
        ('        EM_ASM(JSEvents.inEventHandler = true);\n', ''),
        ('        EM_ASM(JSEvents.currentEventHandler = {allowsDeferredCalls:true});\n', ''),
        ('emscripten_request_fullscreen_strategy(NULL, 0, &s)', 'emscripten_request_fullscreen_strategy("#canvas", 0, &s)'),
        ('int main() {', 'int main(int argc, char **argv) {'),
    ]
    for event in ['keydown', 'keyup', 'resize']:
        replacements.append((f'emscripten_set_{event}_callback(0,',
                             f'emscripten_set_{event}_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW,'))
    for event in ['touchstart', 'touchend', 'touchmove', 'touchcancel', 'mousedown', 'mouseup', 'mousemove']:
        replacements.append((f'emscripten_set_{event}_callback(0,', f'emscripten_set_{event}_callback("#canvas",'))
    for before, after in replacements:
        expected = 2 if before.startswith('emscripten_webgl_create_context') else 1
        if text.count(before) != expected:
            raise RuntimeError('upstream web source changed: ' + before)
        text = text.replace(before, after)
    write(name, text.encode())
    (args.output / 'port.json').write_text(json.dumps(dict(revision=revision, changes=changes), indent=2) + '\n')
    print(f'Prepared {REVISION}; {len(changes)} source files changed')


if __name__ == '__main__':
    main()
