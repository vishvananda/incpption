// Store already-compressed game assets as-is. Blob parts avoid a second copy
// of the complete package when constructing the download.
const crcTable = Uint32Array.from({length:256}, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});
const encoder = new TextEncoder();
const zipLimit = 0xffffffff;

export function webZip(files) {
  const local = [], central = [];
  let offset = 0, directorySize = 0;
  if (files.length > 65535) throw Error('Too many web build outputs.');
  const seen = new Set();
  for (const {path, bytes} of files) {
    if (seen.has(path)) throw Error('Duplicate web build output: ' + path);
    seen.add(path);
    const name = encoder.encode(path);
    if (name.length > 65535 || offset + bytes.length + name.length + 30 > zipLimit)
      throw Error('The web build exceeds the ZIP size limit.');
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;

    const header = new ArrayBuffer(30), entry = new ArrayBuffer(46);
    const h = new DataView(header), e = new DataView(entry);
    h.setUint32(0, 0x04034b50, true);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    const fields = [[4, 20], [6, 0x800], [12, 33], [26, name.length]];
    for (const [at, value] of fields) {
      h.setUint16(at, value, true);
      e.setUint16(at + 2, value, true);
    }
    for (const [at, value] of [[14, crc], [18, bytes.length], [22, bytes.length]]) {
      h.setUint32(at, value, true);
      e.setUint32(at + 2, value, true);
    }
    e.setUint32(42, offset, true);
    local.push(header, name, bytes);
    central.push(entry, name);
    offset += header.byteLength + name.length + bytes.length;
    directorySize += entry.byteLength + name.length;
  }
  if (offset + directorySize + 22 > zipLimit) throw Error('The web build exceeds the ZIP size limit.');
  const end = new ArrayBuffer(22), footer = new DataView(end);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, files.length, true);
  footer.setUint16(10, files.length, true);
  footer.setUint32(12, directorySize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], {type:'application/zip'});
}
