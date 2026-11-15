// Disassemble executable ELF sections, never headers, data, or a rendered MIR.
export function elfCode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length)
      throw Error('Invalid ELF section bounds');
  };
  check(0, 64);
  if (view.getUint32(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || view.getUint16(18, true) !== 62)
    throw Error('Expected a little-endian x86-64 ELF object');
  const u64 = offset => Number(view.getBigUint64(offset, true));
  const base = u64(40), stride = view.getUint16(58, true), count = view.getUint16(60, true);
  if (stride < 64) throw Error('Invalid ELF section size');
  check(base, stride * count);
  const sections = Array.from({length: count}, (_, i) => {
    const p = base + stride * i;
    return {name: view.getUint32(p, true), type: view.getUint32(p + 4, true), flags: u64(p + 8),
      offset: u64(p + 24), size: u64(p + 32), link: view.getUint32(p + 40, true), entrySize: u64(p + 56)};
  });
  const stringAt = (section, offset) => {
    if (!section || offset >= section.size) throw Error('Invalid ELF string');
    check(section.offset, section.size);
    let end = section.offset + offset;
    while (end < section.offset + section.size && bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(section.offset + offset, end));
  };
  const labels = new Map();
  for (const section of sections.filter(s => s.type === 2 && s.entrySize >= 24)) {
    check(section.offset, section.size);
    for (let p = section.offset; p + 24 <= section.offset + section.size; p += section.entrySize) {
      if ((bytes[p + 4] & 15) !== 2) continue;
      const key = `${view.getUint16(p + 6, true)}:${u64(p + 8)}`;
      labels.set(key, stringAt(sections[section.link], view.getUint32(p, true)));
    }
  }
  return sections.flatMap((section, index) => {
    if (!(section.flags & 4) || section.type !== 1) return [];
    check(section.offset, section.size);
    return [{name: stringAt(sections[view.getUint16(62, true)], section.name), index,
      bytes: bytes.subarray(section.offset, section.offset + section.size), labels}];
  });
}

export async function disassemble(bytes, target) {
  if (target === 'wasm') {
    // WABT reads the backing buffer; omit spare output capacity and unrelated views.
    if(bytes.byteOffset||bytes.byteLength!==bytes.buffer.byteLength)bytes=bytes.slice();
    const {default: factory} = await import('./vendor/wabt.mjs');
    const wabt = await factory();
    const module = wabt.readWasm(bytes, {readDebugNames: true, exceptions: true, simd: true, threads: true});
    try {return module.toText({foldExprs: false, inlineExport: false});}
    finally {module.destroy();}
  }
  const iced = await import('./vendor/iced.mjs');
  const formatter = new iced.Formatter(iced.FormatterSyntax.Intel);
  const lines = ['; Actual object instructions. References with relocations are unresolved until linking.'];
  try {
    for (const section of elfCode(bytes)) {
      lines.push(`\n; ${section.name}`);
      const decoder = new iced.Decoder(64, section.bytes, iced.DecoderOptions.None);
      try {
        while (decoder.canDecode) {
          const offset = decoder.position, label = section.labels.get(`${section.index}:${offset}`);
          if (label) lines.push(`${label}:`);
          const instruction = decoder.decode();
          try {lines.push(`${offset.toString(16).padStart(6, '0')}  ${formatter.format(instruction)}`);}
          finally {instruction.free();}
          if (lines.length > 30000) throw Error('Output too large to display; download the object instead.');
        }
      } finally {decoder.free();}
    }
    return lines.join('\n');
  } finally {formatter.free();}
}
