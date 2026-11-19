// Deterministic SysV archives containing x86-64 ELF objects.
const encoder = new TextEncoder();

function symbols(bytes) {
  const elf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (elf.getUint32(0) !== 0x7f454c46 || elf.getUint8(4) !== 2 || elf.getUint8(5) !== 1)
    throw Error('Archive member must be little-endian ELF64');
  const sectionBase = Number(elf.getBigUint64(40, true));
  const sectionSize = elf.getUint16(58, true);
  const section = index => sectionBase + index * sectionSize;
  const u32 = offset => elf.getUint32(offset, true);
  const u64 = offset => Number(elf.getBigUint64(offset, true));
  const count = elf.getUint16(60, true) || u64(section(0) + 32);
  const names = [];
  for (let index = 1; index < count; index++) {
    const header = section(index);
    if (u32(header + 4) !== 2) continue;
    const table = u64(header + 24), size = u64(header + 32), stride = u64(header + 56);
    if (stride < 24 || table + size > bytes.length) throw Error('Invalid ELF symbol table');
    const strings = section(u32(header + 40));
    const strBase = u64(strings + 24), strEnd = strBase + u64(strings + 32);
    for (let at = table + u32(header + 44) * stride; at < table + size; at += stride) {
      const binding = elf.getUint8(at + 4) >> 4;
      const offset = u32(at);
      if (!offset || !elf.getUint16(at + 6, true) || ![1, 2, 10].includes(binding)) continue;
      const first = strBase + offset;
      const end = bytes.indexOf(0, first);
      if (end < first || end >= strEnd) throw Error('Invalid ELF symbol name');
      names.push(bytes.subarray(first, end + 1));
    }
  }
  return names;
}

const padded = size => size + (size & 1);
const headerSize = 60;
const magic = encoder.encode('!<arch>\n');

function header(name, size, table = false) {
  const fields = [name, table ? '' : '0', table ? '' : '0', table ? '' : '0',
    table ? '' : name === '/' ? '0' : '644', String(size)];
  const widths = [16, 12, 6, 6, 8, 10];
  return encoder.encode(fields.map((value, index) => value.padEnd(widths[index])).join('') + '`\n');
}

export function createArchive(files) {
  const longNames = new Map();
  const indexed = [];
  let longSize = 0, symbolSize = 0;
  const members = files.map(({path, bytes}) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    let tag = name + '/';
    const encoded = encoder.encode(name + '/\n');
    if (encoded.length > 17 || name.includes(' ')) {
      if (!longNames.has(name)) {
        longNames.set(name, {at: longSize, bytes: encoded});
        longSize += encoded.length;
      }
      tag = '/' + longNames.get(name).at;
    }
    const row = {tag, bytes};
    for (const name of symbols(bytes)) {
      indexed.push({name, row});
      symbolSize += name.length;
    }
    return row;
  });
  const indexSize = padded(4 + 4 * indexed.length + symbolSize);
  const start = magic.length + headerSize + indexSize + (longSize ? headerSize + padded(longSize) : 0);
  let offset = start;
  for (const row of members) {
    row.offset = offset;
    offset += headerSize + padded(row.bytes.length);
  }
  const archive = new Uint8Array(offset);
  const view = new DataView(archive.buffer);
  archive.set(magic);
  archive.set(header('/', indexSize), magic.length);
  const indexStart = magic.length + headerSize;
  view.setUint32(indexStart, indexed.length);
  let nameOffset = indexStart + 4 + 4 * indexed.length;
  indexed.forEach(({name, row}, index) => {
    view.setUint32(indexStart + 4 + 4 * index, row.offset);
    archive.set(name, nameOffset);
    nameOffset += name.length;
  });
  if (longSize) {
    const tableOffset = indexStart + indexSize;
    archive.set(header('//', padded(longSize), true), tableOffset);
    for (const item of longNames.values()) archive.set(item.bytes, tableOffset + headerSize + item.at);
    if (longSize & 1) archive[start - 1] = 10;
  }
  for (const {tag, bytes, offset} of members) {
    archive.set(header(tag, bytes.length), offset);
    archive.set(bytes, offset + headerSize);
    if (bytes.length & 1) archive[offset + headerSize + bytes.length] = 10;
  }
  return archive;
}
