#!/usr/bin/env python3
"""Flatten generated ARM case-label chains without changing switch behavior."""
import argparse
from pathlib import Path
import re

HEADERS = ['arm_sve_streaming_attrs.inc', 'arm_sme_streaming_attrs.inc', 'arm_sme_builtins_za_state.inc']


def flatten_cases(text):
    # An empty statement ends each case's AST node. Control still falls through
    # to the same shared action, with the same scope and source line numbers.
    return re.sub(r'(?m)^(\s*case [\w:]+:)([ \t]*)$', r'\1;\2', text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generated-basic', type=Path, required=True)
    args = parser.parse_args()
    for name in HEADERS:
        path = args.generated_basic / name
        text = path.read_text()
        result = flatten_cases(text)
        if result == text:
            raise RuntimeError('no original case labels in ' + str(path))
        path.write_text(result)
