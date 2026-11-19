import {compiler, replayAlpine} from './alpine_replay.mjs';
import {runCompilers} from './build_pool.mjs';
import {boundedBytes, rawFile, remote, validatePlan} from './plans.mjs';
import {wasiSdk} from './wasi_sdk.mjs';
import {fetchBytes, fileView, hash, insert, invoke, lookup, mountLayers} from './wasi_runtime.mjs';

const decoder = new TextDecoder();
const json = path => fetchBytes(path).then(data => JSON.parse(decoder.decode(data)));

async function wasiFiles(plan) {
  const generated = plan.generated ?? {};
  const paths = [...plan.sources, ...(plan.files ?? []), ...Object.keys(generated)];
  const files = new Array(paths.length);
  let next = 0, size = 0;
  await Promise.all(Array.from({length: Math.min(8, paths.length)}, async () => {
    while (next < paths.length) {
      const index = next++, path = paths[index];
      const bytes = Object.hasOwn(generated, path) ? new TextEncoder().encode(generated[path]) :
        await boundedBytes(await remote(rawFile(plan, path)), 16 * 1024 * 1024);
      size += bytes.length;
      if (size > 96 * 1024 * 1024) throw Error('The WASI source inputs exceed 96 MiB.');
      files[index] = {path:'checkout/' + path, bytes};
    }
  }));
  const Buffer = self.crossOriginIsolated ? SharedArrayBuffer : ArrayBuffer;
  const bundle = new Uint8Array(new Buffer(size));
  let offset = 0;
  const index = files.map(({path, bytes}) => {
    const row = {path, offset, size:bytes.length};
    bundle.set(bytes, offset);
    offset += bytes.length;
    return row;
  });
  return {files:index, bundle};
}

async function wasi(plan, workers, profile) {
  const [sdk, source, module] = await Promise.all([wasiSdk({shared:true}), wasiFiles(plan), compiler(profile, true)]);
  const layers = [...sdk, source];
  const common = ['--target=wasm32-wasip1', '--sysroot=sysroot', '-resource-dir=resource', '-O3', '-Icheckout'];
  const total = plan.sources.length + 1;
  const flags = plan.compileFlags ?? [];
  const tasks = plan.sources.map((path, index) => {
    const source = 'checkout/' + path, output = 'build/' + index + '.o';
    const language = path.endsWith('.c') && !flags.includes('-x') ? ['-x', 'c'] : [];
    return {source, output, sourceDateEpoch:1735689600,
      progress:{index, total, name:source, source},
      args:[...common, ...language, ...flags, '-c', source, '-o', output]};
  });
  postMessage({kind:'ready', total});
  const root = mountLayers(layers);
  await runCompilers(tasks, module, layers, workers, ({bytes}, task) => {
    insert(root, task.output, fileView(bytes));
    postMessage({kind:'unit', ...task.progress, bytes:bytes.length});
  });
  const output = 'build/' + (plan.output ?? 'program.wasm');
  const progress = {name:'Link ' + output, index:total - 1, total};
  postMessage({kind:'progress', ...progress});
  const args = [...common, ...tasks.map(task => task.output), ...(plan.linkFlags ?? []), '-o', output];
  const result = await invoke(module, root, args, 1735689600);
  if (result.status) throw Error(result.log.join('\n') || 'The WASI link failed.');
  const bytes = lookup(root, output)?.take();
  if (!bytes?.length || !WebAssembly.validate(bytes)) throw Error('The linker did not produce a valid Wasm module.');
  postMessage({kind:'unit', ...progress, bytes:bytes.length});
  return [{path:output, bytes}];
}

self.onmessage = async ({data: {plan, workers, sourceLayer}}) => {
  try {
    validatePlan(plan, plan);
    if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw Error('Choose one to eight workers.');
    const start = performance.now();
    const profile = await json('alpine/profile.json');
    let products;
    if (plan.kind === 'emscripten') {
      const {replayEmscripten} = await import('./emscripten_replay.mjs');
      products = await replayEmscripten(plan, workers, profile, sourceLayer);
    } else products = plan.kind === 'wasi' ? await wasi(plan, workers, profile) : await replayAlpine(plan, workers, profile);
    postMessage({kind:'result', products, seconds:(performance.now() - start) / 1000},
      [...new Set(products.map(file => file.bytes.buffer))]);
  } catch (error) {postMessage({kind:'error', error:error.message || String(error)});}
};
