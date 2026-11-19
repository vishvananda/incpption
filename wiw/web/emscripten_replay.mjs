import {compiler, unpackLayer} from './alpine_replay.mjs';
import {archive} from './ar.mjs';
import {runCompilers} from './build_pool.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {publicURL, remote} from './plans.mjs';
import {loadSeed} from './seed_package.mjs';
import {fetchBytes, hash} from './wasi_runtime.mjs';
import {sha256} from '/vendor/noble/sha2.js';

export async function emscriptenLayer(plan, record, {shared = false, signal} = {}) {
  const url = publicURL(record.path, plan.baseURL);
  const store = record === plan.sdkInputs ? await globalThis.caches?.open('willitwasm-emscripten-sdk-v1').catch(() => null) : null;
  const key = new URL('emscripten-sdk/' + record.sha256, self.location.href);
  const cached = await store?.match(key);
  const response = cached ?? await remote(url, signal);
  const saved = !cached && store && response.clone();
  const stream = record.encoding === 'gzip' ?
    response.body.pipeThrough(new DecompressionStream('gzip')) : response.body;
  const reader = stream.getReader(), digest = sha256.create();
  const Buffer = shared && self.crossOriginIsolated ? SharedArrayBuffer : ArrayBuffer;
  const bytes = new Uint8Array(new Buffer(record.bytes));
  let offset = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const {value, done} = await reader.read();
      if (done) break;
      if (value.length > bytes.length - offset) throw Error('Emscripten inputs exceed the declared size.');
      bytes.set(value, offset);
      digest.update(value);
      offset += value.length;
    }
    const actual = Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
    if (offset !== record.bytes || actual !== record.sha256)
      throw Error('Emscripten inputs differ: ' + record.path);
  } catch (error) {
    if (saved) void saved.body.cancel().catch(() => {});
    await store?.delete(key);
    throw error;
  } finally {
    digest.destroy();
    void reader.cancel().catch(() => {});
  }
  if (saved) await store.put(key, saved).catch(() => {});
  return unpackLayer(bytes);
}

const binaryen = new Map();
async function loadBinaryen(name) {
  if (!binaryen.has(name)) binaryen.set(name, (async () => {
    const descriptor = await remote('binaryen/manifest.json').then(r => r.json());
    const record = descriptor.tools[name];
    const path = 'binaryen/' + name;
    const [bytes, runtime] = await Promise.all([fetchBytes(path + '.wasm'), fetchBytes(path + '.mjs')]);
    if (await hash(bytes) !== record.sha256 || await hash(runtime) !== record.runtimeSha256)
      throw Error('Binaryen tool checksum differs: ' + name);
    return {module: await WebAssembly.compile(bytes), runtime: new URL(path + '.mjs', self.location).href};
  })());
  return binaryen.get(name);
}

const linkerPath = value => value.replace(/(^|=|-L)\/(?=checkout\/|sdk\/|trace\/|emscripten\/|result\/)/g, '$1/inputs/');

export function stripCustom(bytes, names) {
  let cursor = 8;
  const read = () => {
    let value = 0;
    for (let shift = 0; shift < 35 && cursor < bytes.length; shift += 7) {
      const next = bytes[cursor++];
      value += (next & 127) * 2 ** shift;
      if (next < 128) return value;
    }
    throw Error('Invalid Wasm section length.');
  };
  const kept = [bytes.subarray(0, 8)], decoder = new TextDecoder();
  while (cursor < bytes.length) {
    const start = cursor, type = bytes[cursor++];
    const size = read(), end = cursor + size;
    if (end > bytes.length) throw Error('Invalid Wasm section bounds.');
    let omit = false;
    if (type === 0) {
      const length = read();
      if (cursor + length > end) throw Error('Invalid custom section name.');
      omit = names.includes(decoder.decode(bytes.subarray(cursor, cursor + length)));
    }
    if (!omit) kept.push(bytes.subarray(start, end));
    cursor = end;
  }
  const output = new Uint8Array(kept.reduce((size, section) => size + section.length, 0));
  let offset = 0;
  for (const section of kept) {
    output.set(section, offset);
    offset += section.length;
  }
  return output;
}

export async function replayEmscripten(plan, workers, profile, sourceLayer) {
  const [sources, libraries, player, module, sdk] = await Promise.all([
    sourceLayer ?? emscriptenLayer(plan, plan.source, {shared:true}),
    emscriptenLayer(plan, plan.libraries),
    emscriptenLayer(plan, plan.player),
    compiler(profile),
    plan.sdkInputs && emscriptenLayer(plan, plan.sdkInputs),
  ]);
  const entries = Object.entries(plan.archives), total = plan.compilation.length + entries.length + 1 + plan.post.length;
  const artifacts = new Map();
  const progress = (index, name, source) => ({index, total, name, source});
  const tasks = plan.compilation.map(({args, cwd, path, source}, index) => ({
    args, cwd, path, source, output:'/' + path, sourceDateEpoch:plan.epoch, progress:progress(index, source, source),
  }));
  const record = (path, bytes, step) => {
    artifacts.set(path, bytes);
    postMessage({kind:'unit', ...step, bytes:bytes.length});
  };
  postMessage({kind:'ready', total});
  await runCompilers(tasks, module, [sources], workers, ({bytes}, task) => record(task.path, bytes, task.progress));
  let index = tasks.length;
  const pending = new Map(entries);
  while (pending.size) {
    const before = pending.size;
    for (const [path, members] of pending) {
      if (!members.every(member => artifacts.has(member))) continue;
      const step = progress(index++, 'Archive ' + path);
      postMessage({kind:'progress', ...step});
      record(path, archive(members.map(member => ({name:member.split('/').at(-1), bytes:artifacts.get(member)}))), step);
      pending.delete(path);
    }
    if (before === pending.size) throw Error('Archive members are missing or have a dependency cycle.');
  }
  const linker = await loadSeed('lld', (profile.sharedAssets ?? '') + 'clang-seed/');
  const link = progress(index++, 'Link ' + plan.output);
  postMessage({kind:'progress', ...link});
  const files = [...artifacts].map(([path, bytes]) => ({path, bytes}));
  const lldArgs = plan.link.args.map(linkerPath);
  // Emscripten 4.0.9's LLD 21 placed the stack after data by default.
  if (!lldArgs.includes('--stack-first')) lldArgs.push('--no-stack-first');
  const linkOutput = '/inputs/result/' + plan.output;
  let {bytes} = await invokeEmscripten({...linker, program:'wasm-ld', layers:[libraries, ...(sdk ? [sdk] : [])], files,
    cwd:plan.link.cwd, args:lldArgs, output:linkOutput});
  // Emscripten strips host-specific debug information before finalization.
  // Compare at that boundary if the plan's first replay step removes it.
  if (plan.post[0]?.tool !== 'strip-custom' && await hash(bytes) !== plan.link.sha256)
    throw Error('Browser linker output differs from the captured build.');
  postMessage({kind:'unit', ...link, bytes:bytes.length});
  for (const stage of plan.post) {
    const step = progress(index++, stage.tool);
    postMessage({kind:'progress', ...step});
    if (stage.tool === 'strip-custom') bytes = stripCustom(bytes, stage.sections);
    else {
      const tool = await loadBinaryen(stage.tool);
      ({bytes} = await invokeEmscripten({...tool, program:stage.tool, layers:[libraries],
        files:[{path:'input.wasm', bytes}], args:stage.args, output:'output.wasm'}));
    }
    if (await hash(bytes) !== stage.sha256) throw Error('Binaryen output differs from the captured build: ' + stage.tool);
    postMessage({kind:'unit', ...step, bytes:bytes.length});
  }
  if (await hash(bytes) !== plan.sha256 || !WebAssembly.validate(bytes))
    throw Error('Browser output differs from the captured Wasm.');
  if (!player.files.some(file => file.path === plan.entry) || player.files.some(file => /\.wasm$/i.test(file.path)))
    throw Error('Invalid web output package.');
  return [{path:plan.output, bytes}, ...player.files.map(file => ({path:file.path,
    bytes:player.bundle.subarray(file.offset, file.offset + file.size)}))];
}
