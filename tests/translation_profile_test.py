"""Generated encoding preserves all payload bytes, lengths and table entries."""
from pathlib import Path
import re
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from translation_profile import encode_translations
source=b'''// upstream license\ninline constexpr const unsigned char _doc_translation_ca_compressed[] = { 0, 10, 34, 92, 255 };\nconst EditorTranslationList _doc_translations[] = { { "ca", 5, 20, _doc_translation_ca_compressed }, { nullptr, 0, 0, nullptr } };\n'''
encoded=encode_translations(source)
assert encoded==source.replace(b'{ 0, 10, 34, 92, 255 }',b'"\\x00\\x0a\\x22\\x5c\\xff"')
assert bytes.fromhex(b''.join(re.findall(rb'\\x([0-9a-f]{2})',encoded)).decode())==bytes([0,10,34,92,255])
try:encode_translations(b'unknown generated format')
except ValueError:pass
else:raise AssertionError('unknown generator format was accepted')
print('PASS: generated translation encoding retains bytes, table lengths, names and license')
from translation_profile import split_translations
main,parts=split_translations(source)
assert b'extern const unsigned char _doc_translation_ca_compressed[];'in main
assert b'= ;'not in main
assert b'{ "ca", 5, 20, _doc_translation_ca_compressed }'in main
assert list(parts)==['doc_translation_ca.gen.cpp']
assert b'extern const unsigned char _doc_translation_ca_compressed[] = "\\x00'in next(iter(parts.values()))
print('PASS: translation data partitions retain table contents and external definitions')
