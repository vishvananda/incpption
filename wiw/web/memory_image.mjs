// Zero stack/BSS pages need no saved copy. Keep just the initialized range.
export function memoryImage(memory) {
  let start = 0, end = memory.length;
  while (start < end && memory[start] === 0) ++start;
  while (end > start && memory[end - 1] === 0) --end;
  return {capacity: memory.length, offset: start, bytes: memory.slice(start, end)};
}
export function restoreMemory(memory, image, used = memory.length) {
  memory.fill(0, 0, image.offset);
  memory.set(image.bytes, image.offset);
  memory.fill(0, image.offset + image.bytes.length, used);
}
