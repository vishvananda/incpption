import {fetchBytes, hash} from './wasi_runtime.mjs';
// Large executables are split independently of filesystem input bundles. Keep
// just one final buffer and at most two decoded chunks in flight.
export async function loadSeed(name) {
  const bytes = await fetchBytes('clang-seed/manifest.json');
  const expected = new TextDecoder().decode(await fetchBytes('clang-seed/manifest.sha256')).trim();
  if (await hash(bytes) !== expected) throw Error('Clang seed manifest changed');
  const manifest = JSON.parse(new TextDecoder().decode(bytes)), tool = manifest.tools?.[name];
  if (manifest.schema !== 1 || !tool || !Number.isSafeInteger(tool.bytes) || tool.bytes <= 0 || tool.bytes > 512*1048576)
    throw Error('Invalid compiler seed');
  const result = new Uint8Array(tool.bytes);
  let offset = 0, next = 0;
  const chunks = tool.chunks.map(row => {
    if (!/^[\w.-]+\.bin$/.test(row.path) || !Number.isSafeInteger(row.size) || row.size <= 0 || row.size > tool.bytes-offset)
      throw Error('Invalid compiler seed chunk');
    const item = {...row, offset}; offset += row.size; return item;
  });
  if (offset !== tool.bytes || !/^[\w.-]+\.mjs$/.test(tool.runtime.path)) throw Error('Incomplete compiler seed');
  await Promise.all(Array.from({length: Math.min(2, chunks.length)}, async () => {
    while (next < chunks.length) {
      const row = chunks[next++], part = await fetchBytes('clang-seed/' + row.path);
      if (part.length !== row.size || await hash(part) !== row.sha256) throw Error('Compiler seed chunk changed');
      result.set(part, row.offset);
    }
  }));
  if (await hash(result) !== tool.sha256) throw Error('Compiler seed changed');
  const runtime = await fetchBytes('clang-seed/' + tool.runtime.path);
  if (await hash(runtime) !== tool.runtime.sha256) throw Error('Compiler seed runtime changed');
  return {module: await WebAssembly.compile(result), runtime: new URL('clang-seed/' + tool.runtime.path, self.location).href};
}
