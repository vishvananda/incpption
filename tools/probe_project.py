#!/usr/bin/env python3
"""Measure a frozen Emscripten compilation database with cppgm's C/C++ modes."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['database', 'profile', 'compiler', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=8)
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    profile = args.profile.resolve()
    base = json.loads((profile / 'profile.json').read_text())['compiler_flags']
    flags = [('--sysroot=' + str(profile / 'emscripten/cache/sysroot') if value.startswith('--sysroot=')
              else str(profile / value) if value.startswith('emscripten/') or value == 'cppgm_compat.h' else value)
             for value in base]
    database = json.loads(args.database.read_text())
    start = time.monotonic()

    def compile_one(index, item):
        language = 'c' if Path(item['file']).suffix == '.c' else 'c++'
        prefix = [value for value in flags if not value.startswith('-std=') and
                  (language != 'c' or not value.startswith(('-D__GNUG__', '-D__GXX_ABI_VERSION')))]
        original = item.get('arguments') or shlex.split(item['command'])
        actual = []
        for value in original[1:]:
            if value.startswith(('-sMEMORY64=', '-sSUPPORT_LONGJMP=')):
                continue
            if '/emsdk/upstream/emscripten/cache/sysroot' in value:
                marker = '/emsdk/upstream/emscripten/cache/sysroot'
                position = value.index(marker)
                # Preserve the -I/-isystem spelling before an absolute path.
                lead = '-I' if value.startswith('-I') else ''
                value = lead + str(profile / 'emscripten/cache/sysroot') + value[position + len(marker):]
            actual.append(value)
        output = args.output.resolve() / f'{index:05}.o'
        actual[actual.index('-o') + 1] = str(output)
        if language == 'c':
            actual = [v for v in actual if not v.startswith(('-std=c++', '-std=gnu++'))]
        command = [str(args.compiler.resolve()), *prefix, '-x', language, *actual, '-O3']
        before = time.monotonic()
        logfile = output.with_suffix('.log')
        with logfile.open('wb') as log:
            try:
                result = subprocess.run(command, cwd=item['directory'], stdout=log,
                                        stderr=subprocess.STDOUT, timeout=args.timeout)
                status = result.returncode
            except subprocess.TimeoutExpired:
                status = 124
        diagnostics = logfile.read_text(errors='replace')
        row = dict(index=index, source=item['file'], language=language, status=status,
                   seconds=time.monotonic()-before, output=str(output), command=command,
                   diagnostic=diagnostics[-5000:] if status else '')
        if status == 0:
            data = output.read_bytes()
            row.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        output.with_suffix('.json').write_text(json.dumps(row, indent=2) + '\n')
        return row

    rows = []
    with (args.output / 'observations.jsonl').open('w') as log, ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(compile_one, i, item) for i, item in enumerate(database)]
        for future in as_completed(futures):
            row = future.result(); rows.append(row)
            log.write(json.dumps(row) + '\n'); log.flush()
            if len(rows) % 50 == 0 or row['status']:
                print(json.dumps(dict(finished=len(rows), total=len(database), passed=sum(r['status']==0 for r in rows),
                                      source=row['source'], status=row['status'])), flush=True)
    summary = dict(seconds=time.monotonic()-start, jobs=args.jobs, total=len(rows),
                   passed=sum(r['status']==0 for r in rows), rows=sorted(rows, key=lambda row: row['index']))
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k:v for k,v in summary.items() if k != 'rows'}), flush=True)


if __name__ == '__main__':
    main()
