import {compilerBytes} from './alpine_replay.mjs';
import {errorText} from './error_text.mjs';
import {packWorkspace, sourceDateEpoch, workspace} from './nano_plan.mjs';
import {absolute, command, compilerNames, makefiles, quote, sdkRoot, target, toolRelay} from './planner_tools.mjs';
import {boundedBytes} from './plans.mjs';
import {fetchBytes, hash} from './transport_bytes.mjs';
import {wasiSdk} from './wasi_sdk.mjs';

const source = workspace + '/source', tools = '/usr/local/bin';
const decoder = new TextDecoder();
const log = line => postMessage({kind:'log', line});

function readFile(fs, path) {
  const node = fs.resolve(path);
  return node?.isFile ? node.data.subarray(0, node.size) : null;
}

async function verify(url, expected) {
  const bytes = await fetchBytes(url);
  if (await hash(bytes) !== expected) throw Error('NanoVM asset checksum differs: ' + url.pathname);
  return bytes;
}

async function runtimeInputs(runtime) {
  const root = new URL(runtime.root, import.meta.url);
  const load = path => import(new URL(path, root));
  const [host, kernel, wasi, app, wasm, make] = await Promise.all([
    load('runners/riscv/host/nanovm.mjs'), load('kernel/index.mjs'),
    load('runners/wasm/src/wasm-runtime.mjs'), load('runners/wasm/src/wasm-app.mjs'),
    verify(new URL('runtime.bin', root), runtime.wasmSha256),
    verify(new URL('make.bin', root), runtime.makeSha256),
  ]);
  return {NanoVM:host.NanoVM, Kernel:kernel.Kernel, runWasm:wasi.runWasm, appPreopens:app.appPreopens, wasm, make};
}

async function guestCommand(vm, script) {
  const path = '/tmp/wiw-planner.sh';
  vm.addFile(path, 'set -e\n' + script + '\n');
  let line = '';
  const result = await vm.run('sh ' + path, {maxSteps:5000000000, onStdout:text => {
    const parts = (line + text).split('\n');
    line = parts.pop();
    for (const part of parts) log(part);
  }});
  if (line) log(line);
  if (result.exitCode !== 0) throw Error('NanoVM exited with status ' + result.exitCode + '.');
}

function buildCommands(fs, config) {
  const cwd = absolute(source, config.sourceDirectory ?? '.');
  const has = name => fs.resolve(cwd + '/' + name)?.isFile;
  let system = config.system;
  if (system === 'auto') {
    if (has('CMakeLists.txt') || has('meson.build'))
      throw Object.assign(Error('This project needs the Alpine build tools.'), {system:has('CMakeLists.txt') ? 'cmake' : 'meson'});
    system = has('configure') ? 'configure' : makefiles.some(has) ? 'make' : 'auto';
  }
  if (!['configure', 'make'].includes(system)) throw Error('NanoVM supports configure and Make projects.');
  const options = config.options ?? [], targets = config.target ? [config.target] : [];
  const setup = system === 'configure' ? ['sh', './configure', ...options] : [];
  const make = ['make', '-j1', ...(system === 'make' ? options : []), ...targets];
  return {cwd, setup, make};
}

function workspaceFiles(fs, produced) {
  const files = new Map(), root = fs.resolve(workspace);
  const walk = (node, path) => {
    if (node.isDir) {
      for (const [name, child] of node.children) walk(child, path + '/' + name);
      return;
    }
    if (node.isSymlink) {
      node = fs.resolve(path);
      if (!node?.isFile || !fs._pathOf(node).startsWith(workspace + '/')) return;
    }
    if (node.isFile && !produced.has(path)) files.set(path.slice(1), node.data.subarray(0, node.size));
  };
  walk(root, workspace);
  return files;
}

async function configure(input, runtime) {
  const [runtimeAssets, data] = await Promise.all([
    runtimeInputs(runtime),
    boundedBytes(new Response(new Blob([input.archive]).stream().pipeThrough(new DecompressionStream('gzip'))),
      128 * 1024 * 1024),
  ]);
  const {NanoVM, Kernel, wasm, make} = runtimeAssets;
  const kernel = new Kernel();
  log('Starting NanoVM.');
  const vm = await NanoVM.create({wasm, kernel, ramMB:192});
  try {
    vm.setNetwork({disabled:true});
    vm.makeDir(source);
    vm.addFile('/tmp/wiw-source.tar', data);
    await guestCommand(vm, 'cd ' + quote(source) + '\ntar -xf /tmp/wiw-source.tar --strip-components=1');
    vm.removePath('/tmp/wiw-source.tar');
    const fs = kernel.vfs.rootMem;
    const {cwd, setup, make:build} = buildCommands(fs, input.config);
    const [compiler, sdk] = await Promise.all([
      fetchBytes('alpine/profile.json').then(bytes => compilerBytes(JSON.parse(decoder.decode(bytes)), true)),
      wasiSdk(),
    ]);
    vm.addFile('/usr/bin/make', make, 0o755);
    for (const {files, bundle} of sdk) {
      for (const {path, offset, size} of files)
        fs.createFile(sdkRoot + '/' + path, bundle.subarray(offset, offset + size));
    }
    const {runWasm, appPreopens} = runtimeAssets;
    const trace = toolRelay({
      read: path => readFile(fs, path),
      write: (path, bytes) => fs.createFile(path, bytes),
      async runCompiler({cwd, flags, env, caps}) {
        const result = await runWasm(kernel, {wasmBytes:compiler, argv:['cppgm', ...flags], cwd,
          env:{...env, PWD:cwd}, caps, timeoutMs:30000, preopens:appPreopens(kernel, caps, cwd)});
        if (result.error) throw Error(result.error.split('\n')[0]);
        return result;
      },
    });
    kernel.router.registerDelegate('wiw-tools', trace.call);
    for (const name of [...compilerNames, 'ar', 'ranlib']) {
      kernel.router.pin(name, 'wiw-tools');
      fs.createFile(tools + '/' + name, new Uint8Array(), 0o755);
    }
    const env = 'cd ' + quote(cwd) + '\nexport TZ=UTC LC_ALL=C SOURCE_DATE_EPOCH=' + sourceDateEpoch +
      ' CC=cc CXX=c++ AR=ar RANLIB=ranlib PATH=' + tools + ':/usr/bin:/bin\n';
    if (setup.length) {
      log('$ ' + setup.join(' '));
      try {
        await guestCommand(vm, env + command(setup));
      } catch (error) {
        const configLog = vm.readFileString(cwd + '/config.log') ?? vm.readFileString(cwd + '/configure.log');
        if (configLog) log(configLog.trimEnd().split('\n').slice(-15).join('\n'));
        throw error;
      }
    }
    trace.start();
    log('$ ' + build.join(' '));
    await guestCommand(vm, env + command(build));
    return {workflow:trace.finish(path => Boolean(readFile(fs, path))), snapshot:packWorkspace(workspaceFiles(fs, trace.produced))};
  } finally {
    vm.destroy();
  }
}

self.onmessage = async ({data:{input, runtime}}) => {
  try {
    const {workflow, snapshot} = await configure(input, runtime);
    postMessage({kind:'configured', workflow, snapshot}, [snapshot.buffer]);
  } catch (error) {
    postMessage({kind:'error', error:errorText(error), system:error.system});
  }
};
