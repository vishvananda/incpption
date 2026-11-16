import {growingFileClass} from './file_buffers.mjs';
import {WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory} from './shim/index.js';
import {fetchBytes} from './transport_bytes.mjs';
import {bundleLayers} from './bundle_layers.mjs';
import {errorText} from './error_text.mjs';
import {runWasiProcess} from './wasi_process.mjs';
export {fetchBytes};

export const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export const hash = async bytes => {
  if(typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)bytes=new Uint8Array(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
};
export function equal(a, b, name) {
  const end = Math.min(a.length, b.length);
  let offset = 0;
  while (offset < end && a[offset] === b[offset]) ++offset;
  if (offset !== end || a.length !== b.length)
    throw Error(`${name}: first byte difference at ${offset}, sizes ${a.length}/${b.length}`);
}
export function insert(root, path, file) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    if (!dir.contents.has(part)) dir.contents.set(part, new Directory([]));
    dir = dir.contents.get(part);
  }
  dir.contents.set(parts.at(-1), file);
}
export function lookup(root, path) {
  let node = root;
  for (const part of path.split('/')) node = node?.contents?.get(part);
  return node;
}
const OutputFile=growingFileClass(File,OpenFile);
export function invoke(module, root, args, sourceDateEpoch) {
  const index=args.lastIndexOf('-o');
  if(index>=0)insert(root,args[index+1],new OutputFile());
  const log = [];
  const wasi = new WASI(['cppgm', ...args], [], [new OpenFile(new File([])),
    ConsoleStdout.lineBuffered(s => log.push(s)), ConsoleStdout.lineBuffered(s => log.push(s)),
    new PreopenDirectory('.', root.contents)], {debug: false});
  if(sourceDateEpoch!==undefined){
    const clock=wasi.wasiImport.clock_time_get;
    wasi.wasiImport.clock_time_get=(id,precision,pointer)=>{
      if(id!==0)return clock(id,precision,pointer);
      new DataView(wasi.inst.exports.memory.buffer).setBigUint64(pointer,BigInt(sourceDateEpoch)*1000000000n,true);return 0;
    };
  }
  return runWasiProcess(module, wasi).then(result => ({...result, log})).catch(error => {
    throw Error([...log, errorText(error)].join('\n'));
  });
}

export {File, Directory};

// browser_wasi_shim's File constructor copies typed arrays. Input views are
// immutable and output buffers have a single owner, so keep their storage.
export function fileView(bytes, readonly = true) {
  const file = new File([], {readonly});
  file.data = bytes;
  return file;
}
export function mountLayers(layers) {
  const root = new Directory([]);
  for (const {files, bundle} of layers)
    for (const item of files)
      insert(root, item.path, fileView(bundle.subarray(item.offset, item.offset + item.size)));
  return root;
}
export function shareBytes(bytes) {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return bytes;
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  return shared;
}

export async function loadCompiler(prefix = '', {shareInputs = false, inputProfile = 'wasm', compileModule = true} = {}) {
    const manifestBytes = await fetchBytes(prefix + 'manifest.json');
    const expectedManifest = new TextDecoder().decode(await fetchBytes(prefix + 'manifest.sha256')).trim();
    if (await hash(manifestBytes) !== expectedManifest) throw Error('manifest hash mismatch');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.schema !== 1) throw Error('unsupported input manifest');
    for (const [path, expected] of Object.entries(manifest.shim_files))
      if (await hash(await fetchBytes(prefix + path)) !== expected) throw Error(`shim changed: ${path}`);
    for (const [path, expected] of Object.entries(manifest.runner_files))
      if (await hash(await fetchBytes(prefix + path)) !== expected) throw Error(`runner changed: ${path}`);
    const layers = [];
    const root = mountLayers(layers);
    const seedRecord = JSON.parse(new TextDecoder().decode(await fetchBytes(prefix + 'w1-complete.json')));
    if (seedRecord.manifest !== expectedManifest) throw Error('seed used a different input manifest');
    const seedBytes = await fetchBytes(prefix + 'inputs/w1/cppgm.wasm');
    if (await hash(seedBytes) !== seedRecord.commands.at(-1).sha256) throw Error('seed hash mismatch');
    const module = compileModule ? await WebAssembly.compile(seedBytes) : null;
    const compiler = {manifest, expectedManifest, root, seedBytes, module, layers};
    const loaded = new Set(), cache = new Map();
    compiler.ensureInputs = async (profile = 'wasm') => {
      if (profile === 'none') return;
      if (!['wasm', 'all'].includes(profile)) throw Error('Unknown compiler input profile');
      const extra = await bundleLayers(prefix, manifest, {shared: shareInputs, cache,
        select: file => !loaded.has(file.path) && (profile === 'all' || !file.path.startsWith('x86/'))});
      layers.push(...extra);
      for (const layer of extra) for (const file of layer.files) {
        insert(root, file.path, fileView(layer.bundle.subarray(file.offset, file.offset + file.size)));
        loaded.add(file.path);
      }
    };
    await compiler.ensureInputs(inputProfile);
    return compiler;
}
