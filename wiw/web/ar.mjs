// The Wasm linker reads each member directly; no external archiver is needed.
export function archive(members) {
  const encoder = new TextEncoder();
  const headers = members.map(({name, bytes}) => {
    const encoded = encoder.encode(name), size = encoded.length + bytes.length;
    const header = (`#1/${encoded.length}`).padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) +
      '0'.padEnd(6) + '100644'.padEnd(8) + String(size).padEnd(10) + '`\n';
    return {header: encoder.encode(header), encoded, bytes, padding: size & 1};
  });
  const result = new Uint8Array(8 + headers.reduce((sum, row) => sum + 60 + row.encoded.length + row.bytes.length + row.padding, 0));
  result.set(encoder.encode('!<arch>\n'));
  let offset = 8;
  for (const row of headers) {
    for (const part of [row.header, row.encoded, row.bytes]) {result.set(part, offset); offset += part.length;}
    if (row.padding) result[offset++] = 10;
  }
  return result;
}
