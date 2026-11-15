"""Encode Godot's generated translation bytes as equivalent C++ string literals.

The table's explicit compressed lengths are unchanged. Each string adds one
unused NUL byte; all compressed bytes and all translations are retained.
"""
import re

ARRAY=re.compile(r'(inline constexpr const unsigned char _doc_translation_\w+_compressed\[\] = )\{\s*([\d,\s]+)\};')
ESCAPES=tuple('\\x'+format(value,'02x')for value in range(256))
def encode_translations(data):
    text=data.decode();count=0
    def encode(match):
        nonlocal count
        values=bytes(int(token.group())for token in re.finditer(r'\d+',match[2]))
        count+=1
        return match[1]+'"'+''.join(ESCAPES[value]for value in values)+'";'
    result=ARRAY.sub(encode,text)
    if not count:raise ValueError('Godot generated translation format changed')
    return result.encode()

def split_translations(data):
    """Generate one data unit per locale plus the unchanged translation table."""
    text=data.decode();parts={};license=text[:text.index('inline constexpr const unsigned char')]
    def split(match):
        declaration=match[1]
        name=re.search(r'_doc_translation_(\w+)_compressed',declaration)[1]
        encoded=encode_translations(match[0].encode()).decode()
        definition=encoded.replace('inline constexpr const unsigned char','extern const unsigned char',1)
        parts['doc_translation_'+name+'.gen.cpp']=(license+definition+'\n').encode()
        return declaration.replace('inline constexpr const unsigned char','extern const unsigned char',1).rsplit('=',1)[0].rstrip()+';'
    main=ARRAY.sub(split,text)
    if not parts:raise ValueError('Godot generated translation format changed')
    return main.encode(),parts
