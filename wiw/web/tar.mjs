const encode = value => new TextEncoder().encode(value);
const padded = length => Math.ceil(length / 512) * 512;

export function tar(parts) {
  const length = parts.reduce((total, [, bytes]) => total + 512 + padded(bytes.length), 1024);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const [name, bytes] of parts) {
    let filename = encode(name), prefix = new Uint8Array();
    if (filename.length > 100) {
      const split = name.lastIndexOf('/');
      if (split < 0) throw Error('Batch filename is too long.');
      prefix = encode(name.slice(0, split));
      filename = encode(name.slice(split + 1));
      if (filename.length > 100 || prefix.length > 155) throw Error('Batch filename is too long.');
    }
    const header = output.subarray(offset, offset + 512);
    const put = (at, text) => header.set(encode(text), at);
    const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';
    header.set(filename);
    header.set(prefix, 345);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, octal(bytes.length, 12));
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, '0');
    put(257, 'ustar\0' + '00');
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(148, sum.toString(8).padStart(6, '0') + '\0 ');
    output.set(bytes, offset + 512);
    offset += 512 + padded(bytes.length);
  }
  return output;
}
