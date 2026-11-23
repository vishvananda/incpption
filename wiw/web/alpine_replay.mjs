import {relativePath} from './plans.mjs';
import {archive} from './ar.mjs';
import {wasiSdk} from './wasi_sdk.mjs';
import {createArchive} from './archive.mjs';
import {runCompilers} from './build_pool.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {loadSeed} from './seed_package.mjs';
import {fetchBytes, hash, shareBytes, workspacePath, mountLayers, fileView, insert, invoke, lookup} from './wasi_runtime.mjs';

const decoder = new TextDecoder();

export function unpackLayer(bytes, shared = false) {
  if (bytes.byteLength < 4) throw Error('Missing workspace index.');
  const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (size > bytes.length - 4 || size > 12 * 1024 * 1024) throw Error('Invalid workspace index size.');
  const header = typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer ? bytes.slice(4, 4 + size) : bytes.subarray(4, 4 + size);
  const files = JSON.parse(decoder.decode(header));
  if (!Array.isArray(files) || files.length > 100000) throw Error('Invalid workspace records.');
  const bundle = bytes.subarray(4 + size);
  const names = new Set();
  for (const row of files) {
    const path = relativePath(row.path);
    if (names.has(path) || !Number.isSafeInteger(row.offset) || !Number.isSafeInteger(row.size) ||
        row.offset < 0 || row.size < 0 || row.size > bundle.length - row.offset)
      throw Error('Invalid workspace file: ' + path);
    names.add(path);
  }
  return {files, bundle: shared ? shareBytes(bundle) : bundle};
}

export async function sdkLayer({path, sha256}) {
  const bytes = await fetchBytes('alpine/' + relativePath(path));
  if (await hash(bytes) !== sha256) throw Error('SDK checksum differs: ' + path);
  return unpackLayer(bytes, true);
}

export async function compilerBytes(profile, wasi = false) {
  const shared = wasi && profile.sharedAssets && profile.wasiCompilerSha256;
  const bytes = await fetchBytes(shared ? profile.sharedAssets + 'compiler/inputs/w1/cppgm.wasm' : 'alpine/cppgm.bin');
  if (await hash(bytes) !== (shared ? profile.wasiCompilerSha256 : profile.compilerSha256)) throw Error('Compiler checksum differs.');
  return bytes;
}

export async function compiler(profile, wasi = false) {
  return WebAssembly.compile(await compilerBytes(profile, wasi));
}

function commands(plan, wasi = false) {
  if (plan?.cwlVersion !== 'v1.2' || plan.class !== 'Workflow' || !plan.steps || !plan.outputs)
    throw Error('Expected a CWL v1.2 workflow.');
  const entries = Object.entries(plan.steps);
  if (!entries.length || entries.length > 10000) throw Error('Unexpected CWL step count.');
  return entries.map(([id, step], index) => {
    const {baseCommand, arguments: argv, requirements, outputs} = step.run;
    const [directory, separator, command, ...args] = argv;
    if (baseCommand !== 'env' || !directory.startsWith('--chdir=/tmp/incpption/') || separator !== '--' ||
        !['cppgm', 'ar', wasi ? 'wasi-link' : 'ld.lld'].includes(command) || args.some(arg => typeof arg !== 'string'))
      throw Error('Unsupported command in ' + id);
    const cwd = directory.slice('--chdir=/'.length);
    const output = command === 'ar' ? args[1] : args[args.lastIndexOf('-o') + 1];
    const root = requirements.DockerRequirement.dockerOutputDirectory;
    const path = relativePath(workspacePath(cwd, output));
    if (!path.startsWith('tmp/incpption/') || path !== workspacePath(root, outputs.file.outputBinding.glob))
      throw Error('Output path differs in ' + id);
    const sourceArg = command === 'cppgm' && args.find(arg => /\.(c|cc|cpp|cxx|s)$/i.test(arg) && !arg.startsWith('-'));
    return {id: id + '/file', command, args, cwd, path, output, index,
      source: sourceArg ? workspacePath(cwd, sourceArg) : null,
      sourceDateEpoch: Number(requirements.EnvVarRequirement.envDef.SOURCE_DATE_EPOCH),
      dependencies: Object.values(step.in).filter(ref => ref !== 'snapshot')};
  });
}

export function linkerArguments(args) {
  const input = path => '/inputs/' + workspacePath('', path);
  return args.map((arg, index) => {
    if (['-dynamic-linker', '--dynamic-linker'].includes(args[index - 1])) return arg;
    if (arg.startsWith('-L/')) return '-L' + input(arg.slice(2));
    if (arg.startsWith('/')) return input(arg);
    return arg;
  });
}

export async function replayAlpine(plan, workers, profile) {
  const wasi = plan.target === 'wasm32-wasip1';
  const tasks = commands(plan.workflow, wasi);
  const compileTasks = tasks.filter(task => task.command === 'cppgm');
  const linkTasks = tasks.filter(task => task.command === (wasi ? 'wasi-link' : 'ld.lld'));
  const archives = tasks.filter(task => task.command === 'ar');
  if (!wasi && compileTasks.some(task => task.dependencies.length)) throw Error('This plan needs generated compile inputs.');
  const sources = unpackLayer(plan.snapshot, true);
  const sdk = wasi ? (await wasiSdk({shared:true})).map(layer => ({...layer, files:layer.files.map(file =>
    ({...file, path:'tmp/will-wasi/' + file.path}))})) : [await sdkLayer(profile.headers)];
  const compileLayers = [sources, ...sdk];
  const module = await compiler(profile, wasi);
  if (compileTasks.some(task => task.args.some(arg => arg.includes('/include/c++/'))))
    compileLayers.push(await sdkLayer(profile.cxxHeaders));
  postMessage({kind:'ready', total: tasks.length});
  const artifacts = new Map();
  const record = (task, bytes) => {
    artifacts.set(task.id, {path: task.path, bytes});
    postMessage({kind:'unit', index:task.index, total:tasks.length, source:task.source, name:task.path, bytes:bytes.length});
  };
  const label = task => ({index: task.index, total: tasks.length, name: task.path, source: task.source});
  await runCompilers(compileTasks.map(task => ({...task, progress:label(task)})), module, compileLayers, workers,
    ({bytes}, task) => record(task, bytes));
  const linkLayers = [sources];
  let linker;
  if (!wasi && linkTasks.length) {
    postMessage({kind:'loading', message:'Loading the Linux linker and runtime'});
    linker = await loadSeed('lld', (profile.sharedAssets ?? '') + 'clang-seed/');
    linkLayers.push(await sdkLayer(profile.link));
    if (linkTasks.some(task => task.args.includes('-lstdc++'))) linkLayers.push(await sdkLayer(profile.cxxLink));
  }
  for (const task of [...archives, ...linkTasks]) {
    postMessage({kind:'progress', ...label(task)});
    const files = task.dependencies.map(ref => {
      if (!artifacts.has(ref)) throw Error('Missing step output: ' + ref);
      return artifacts.get(ref);
    });
    if (task.command === 'ar') {
      const members = new Map(files.map(file => [file.path, file]));
      const ordered = task.args.slice(2).map(name => {
        const member = members.get(workspacePath(task.cwd, name));
        if (!member) throw Error('Missing archive member: ' + name);
        return member;
      });
      record(task, wasi ? archive(ordered.map(file => ({name:file.path.split('/').at(-1), bytes:file.bytes}))) : createArchive(ordered));
    } else if (wasi) {
      const root = mountLayers(compileLayers);
      for (const file of files) insert(root, file.path, fileView(file.bytes));
      const result = await invoke(module, root, task.args, task.sourceDateEpoch, task.cwd);
      if (result.status) throw Error(result.log.join('\n') || 'The WASI link failed.');
      const bytes = lookup(root, task.path)?.take();
      if (!bytes || !WebAssembly.validate(bytes)) throw Error('The link produced an invalid Wasm module.');
      record(task, bytes);
    } else {
      const {bytes} = await invokeEmscripten({...linker, program:'ld.lld', layers:linkLayers,
        files, args:linkerArguments(task.args), cwd:task.cwd, output:task.output.startsWith('/') ? '/inputs' + task.output : task.output});
      record(task, bytes);
    }
  }
  const products = Object.values(plan.workflow.outputs).map(({outputSource}) => artifacts.get(outputSource));
  if (!products.length || products.some(product => !product)) throw Error('CWL workflow did not produce its declared outputs.');
  return products.map(file => wasi && !/\.(a|wasm)$/.test(file.path) ? {...file, path:file.path + '.wasm'} : file);
}
