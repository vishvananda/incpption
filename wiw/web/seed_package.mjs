import {fetchBytes, hash} from './transport_bytes.mjs';
import {sha256} from '/vendor/noble/sha2.js';

// Validate and compile one decoded chunk at a time. No complete executable or
// whole-file WebCrypto input copy is retained alongside the compiled module.
export async function compileSeed(tool, prefix = 'clang-seed/', {read = fetchBytes} = {}) {
  let offset = 0;
  if (!Number.isSafeInteger(tool.bytes) || tool.bytes <= 0 || tool.bytes > 512*1048576 || !Array.isArray(tool.chunks))
    throw Error('Invalid compiler seed');
  for (const row of tool.chunks) {
    if (!/^[\w.-]+\.bin$/.test(row.path) || !Number.isSafeInteger(row.size) || row.size <= 0 || row.size > tool.bytes-offset)
      throw Error('Invalid compiler seed chunk');
    offset += row.size;
  }
  if (offset !== tool.bytes) throw Error('Incomplete compiler seed');
  const digest = sha256.create(), abort = new AbortController();
  let next = 0, cancelled = false, readError;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (next === tool.chunks.length) {
          const actual = Array.from(digest.digest(), n => n.toString(16).padStart(2, '0')).join('');
          if (actual !== tool.sha256) throw Error('Compiler seed changed');
          controller.close(); return;
        }
        const row = tool.chunks[next++], part = await read(prefix + row.path, {signal: abort.signal});
        if (part.length !== row.size || await hash(part) !== row.sha256) throw Error('Compiler seed chunk changed');
        digest.update(part); controller.enqueue(part);
      } catch (error) {
        if (!cancelled) {
          readError = error;
          controller.error(error);
        }
      }
    },
    cancel() {cancelled = true; abort.abort(); digest.destroy();},
  }, {highWaterMark: 0});
  try {
    return await WebAssembly.compileStreaming(new Response(stream, {headers: {'Content-Type': 'application/wasm'}}));
  } catch (error) {
    throw readError ?? error;
  } finally {abort.abort(); digest.destroy();}
}

export async function loadSeed(name, prefix = 'clang-seed/') {
  const bytes = await fetchBytes(prefix + 'manifest.json');
  const expected = new TextDecoder().decode(await fetchBytes(prefix + 'manifest.sha256')).trim();
  if (await hash(bytes) !== expected) throw Error('Clang seed manifest changed');
  const manifest = JSON.parse(new TextDecoder().decode(bytes)), tool = manifest.tools?.[name];
  if (manifest.schema !== 1 || !tool || !/^[\w.-]+\.mjs$/.test(tool.runtime?.path))
    throw Error('Invalid compiler seed');
  const runtime = await fetchBytes(prefix + tool.runtime.path);
  if (await hash(runtime) !== tool.runtime.sha256) throw Error('Compiler seed runtime changed');
  return {module: await compileSeed(tool, prefix), runtime: new URL(prefix + tool.runtime.path, self.location).href};
}
