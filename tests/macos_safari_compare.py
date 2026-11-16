"""Compare two frozen builds in Safari on the same Mac, retaining all runs."""
import json
import os
from pathlib import Path
import subprocess
import sys

out = Path('build/macos-safari')
out.mkdir(parents=True, exist_ok=True)
observations = []
for label, origin in [('A1', os.environ['SAFARI_TEST_ORIGIN']),
                      ('B1', os.environ['SAFARI_COMPARE_ORIGIN']),
                      ('B2', os.environ['SAFARI_COMPARE_ORIGIN']),
                      ('A2', os.environ['SAFARI_TEST_ORIGIN'])]:
    # Close the preceding browser so its Wasm heaps cannot consume fast-memory
    # reservations in the following run. Each run creates a new driver session.
    subprocess.run(['pkill', '-x', 'Safari'], check=False)
    host = {'load': os.getloadavg(), 'memory': subprocess.check_output(
        ['sysctl', 'hw.memsize', 'vm.swapusage'], text=True)}
    environment = dict(os.environ, SAFARI_TEST_ORIGIN=origin, SAFARI_TEST_MODE='comparison',
                       SAFARI_TEST_OUTPUT=str(out / label))
    subprocess.run([sys.executable, str(Path(__file__).with_name('macos_safari_test.py'))],
                   env=environment, check=True)
    report = json.loads((out / label / 'report.json').read_text())
    observations.append({'label': label, 'origin': origin, 'host': host,
                         'cppgm': report['cppgm']['compileSeconds'],
                         'clang': report['clang']['compileSeconds']})
    (out / 'comparison.json').write_text(json.dumps(observations, indent=2) + '\n')
    print(json.dumps(observations[-1]), flush=True)
