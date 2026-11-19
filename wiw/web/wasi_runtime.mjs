import {growingFileClass} from './file_buffers.mjs';
import {WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory} from '/shim/index.js';
import {fetchBytes, hash} from './transport_bytes.mjs';
import {bundleLayers} from './bundle_layers.mjs';
import {errorText} from './error_text.mjs';
import {runWasiProcess} from './wasi_process.mjs';
export {fetchBytes, hash};

export const encoder = new TextEncoder();
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
export function workspacePath(cwd, name) {
  const parts = [];
  for (const part of (name.startsWith('/') ? name : cwd + '/' + name).split('/')) {
    if (part === '..') {
      if (!parts.length) throw Error('Path escapes the workspace: ' + name);
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function workDirectories(root, cwd) {
  if (!cwd) return [new PreopenDirectory('.', root.contents)];
  const parts = cwd.split('/');
  const preopens = [];
  const mount = (name, dir) => {
    const preopen = new PreopenDirectory(name, dir.contents);
    preopen.dir = dir;
    preopens.push(preopen);
  };
  // wasi-libc treats '/' and '.' as equivalent preopen prefixes. Give
  // absolute paths a more specific match than the current directory.
  for (const [name, dir] of root.contents) {
    if (dir instanceof Directory) mount('/' + name, dir);
  }
  let name = '.';
  // WASI has no chdir. Relative ancestor mounts preserve ../source inputs
  // from out-of-tree build directories without changing compiler arguments.
  while (parts.length) {
    const dir = lookup(root, parts.join('/'));
    if (!dir) throw Error('Missing working directory: ' + cwd);
    mount(name, dir);
    parts.pop();
    name = name === '.' ? '..' : name + '/..';
  }
  return preopens;
}

export function invoke(module, root, args, sourceDateEpoch, cwd = '') {
  const index=args.lastIndexOf('-o');
  if(index>=0)insert(root,cwd?workspacePath(cwd,args[index+1]):args[index+1],new OutputFile());
  const log = [];
  const wasi = new WASI(['cppgm', ...args], [], [new OpenFile(new File([])),
    ConsoleStdout.lineBuffered(s => log.push(s)), ConsoleStdout.lineBuffered(s => log.push(s)),
    ...workDirectories(root, cwd)], {debug: false});
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

export async function loadCompiler(prefix = '', {shareInputs = false, inputProfile = 'wasm', compileModule = true, loadSeedBytes = true} = {}) {
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
    let seedBytes = null, module = null;
    if (loadSeedBytes) {
      const seedRecord = JSON.parse(new TextDecoder().decode(await fetchBytes(prefix + 'w1-complete.json')));
      if (seedRecord.manifest !== expectedManifest) throw Error('seed used a different input manifest');
      seedBytes = await fetchBytes(prefix + 'inputs/w1/cppgm.wasm');
      if (await hash(seedBytes) !== seedRecord.commands.at(-1).sha256) throw Error('seed hash mismatch');
      module = compileModule ? await WebAssembly.compile(seedBytes) : null;
    } else if (compileModule) throw Error('Compiler module requires seed bytes');
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
