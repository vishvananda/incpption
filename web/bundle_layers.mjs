import {fetchBytes} from './transport_bytes.mjs';

async function hash(bytes) {
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) bytes = new Uint8Array(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
function share(bytes, enabled) {
  if (!enabled || !globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || bytes.buffer instanceof SharedArrayBuffer) return bytes;
  const result = new Uint8Array(new SharedArrayBuffer(bytes.length)); result.set(bytes); return result;
}
export async function bundleLayers(prefix, manifest, {shared = false, select = () => true, cache = new Map()} = {}) {
  const transport = JSON.parse(new TextDecoder().decode(await fetchBytes(prefix + 'transport.json')));
  if (transport.schema !== 1 || transport.sha256 !== manifest.bundle_sha256 || !Array.isArray(transport.chunks))
    throw Error('Input transport does not match the frozen manifest');
  let position = 0;
  for (const row of transport.chunks) {
    if (row.offset !== position || !Number.isSafeInteger(row.size) || row.size < 0 ||
        !/^chunks\/[\w.-]+$/.test(row.path) && row.path !== 'bundle.bin') throw Error('Invalid input chunk');
    position += row.size;
  }
  if (!Number.isSafeInteger(position) || position !== transport.bytes) throw Error('Input chunks do not cover the bundle');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.offset) || !Number.isSafeInteger(file.size) || file.offset < 0 || file.size < 0 ||
        file.offset > transport.bytes || file.size > transport.bytes - file.offset ||
        typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '..') ||
        paths.has(file.path)) throw Error('Invalid frozen input bounds or path');
    paths.add(file.path);
  }
  const wanted = manifest.files.filter(select);
  let next = 0;
  const jobs = transport.chunks.flatMap((row, index) => {
    const files = wanted.filter(file => file.offset >= row.offset && (file.offset < row.offset + row.size ||
      file.size === 0 && index === transport.chunks.length - 1 && file.offset === row.offset + row.size));
    if (!files.length) return [];
    for (const file of files) if (file.size < 0 || file.offset + file.size > row.offset + row.size) throw Error('Chunk splits an input file');
    return [{row, files}];
  });
  const layers = new Array(jobs.length);
  await Promise.all(Array.from({length: Math.min(4, jobs.length)}, async () => {
    while (next < jobs.length) {
      const index = next++, {row, files} = jobs[index];
      let bundle = cache.get(row.path);
      if (!bundle) {
        bundle = await fetchBytes(prefix + row.path);
        if (bundle.length !== row.size || await hash(bundle) !== row.sha256) throw Error('Input chunk checksum mismatch');
      }
      for (const file of files)
        if (await hash(bundle.subarray(file.offset - row.offset, file.offset - row.offset + file.size)) !== file.sha256)
          throw Error('Input checksum mismatch: ' + file.path);
      bundle = share(bundle, shared && !cache.has(row.path));
      cache.set(row.path, bundle);
      layers[index] = {bundle, files: files.map(file => ({...file, offset: file.offset - row.offset}))};
    }
  }));
  if (layers.reduce((sum, layer) => sum + layer.files.length, 0) !== wanted.length) throw Error('Input files are outside their chunks');
  return layers;
}
