#!/usr/bin/env python3
"""Generated case labels keep their values, source lines and fallthrough."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from llvm_source_profile import flatten_cases

original = '''switch (n) {
  case ARM::first:
  case ARM::second:
    return 1;
  case 2: return 2;
  default: return 0;
}
'''
expected = original.replace('case ARM::first:', 'case ARM::first:;').replace('case ARM::second:', 'case ARM::second:;')
assert flatten_cases(original) == expected
assert flatten_cases(expected) == expected
assert flatten_cases(original).count('\n') == original.count('\n')
print('PASS: bounded-depth case profile preserves lines and shared actions')
