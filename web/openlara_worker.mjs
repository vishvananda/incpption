import {useInputPort} from './transport_bytes.mjs';
import {Directory, hash, equal, insert, lookup, invoke, loadCompiler, fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';
import {loadGamePackage} from './game_package.mjs';
import {loadSeed} from './seed_package.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {clangCompileArgs, lldArgs} from './clang_arguments.mjs';

let release;
self.onmessage = async ({data}) => {
  if (data.kind === 'start') {release?.(); return;}
  useInputPort(data.inputPort);
  const started = performance.now(), pool = new CompilePool(data.ports);
  try {
    postMessage({kind: 'loading', message: 'Checking compiler and game inputs'});
    const compiler = await loadCompiler('compiler/', {shareInputs: true, inputProfile: 'none'});
    const {expectedManifest, root, seedBytes, module: seedModule, layers} = compiler;
    let module = seedModule;
    if (data?.compilerBytes) {
      equal(seedBytes, data.compilerBytes, 'rebuilt compiler');
      module = await WebAssembly.compile(data.compilerBytes);
    }
    const {manifest, expected} = await loadGamePackage(compiler, {shared: true, prefix: data.package || 'game/'});
    root.contents.set('build', new Directory([]));
    const clang = data.compiler === 'clang' ? await loadSeed('clang') : null;
    const lld = clang ? await loadSeed('lld') : null;
    postMessage({kind: 'ready', sources: manifest.commands.map(command => command.name), workerCount: data.workerCount});
    await pool.initialize(clang?.module || module, layers, clang ? {runtime: clang.runtime, program: 'clang++'} : null);
    if (data.barrier) {
      const start = new Promise(resolve => {release = resolve;});
      postMessage({kind: 'prepared'}); await start; release = null;
    }
    const compileStarted = performance.now();
    const tasks = manifest.commands.slice(0, -1).map((command, index) => ({...command, args: clang ? clangCompileArgs(command.args) : command.args,
      progress: {index, total: manifest.commands.length, name: command.name}}));
    const rows = await pool.run(tasks, async (result, command, index) => {
      if (!clang) equal(lookup(root, command.expected).data, result.bytes, command.output);
      insert(root, command.output, fileView(result.bytes));
      const row = {name: command.name, args: command.args, output: command.output, bytes: result.bytes.length,
        sha256: await hash(result.bytes), seconds: result.seconds, status: result.status,
        memoryBytes: result.memoryBytes, log: result.log};
      postMessage({kind: 'unit', index, total: manifest.commands.length, ...row});
      return row;
    });
    const command = manifest.commands.at(-1), index = tasks.length, before = performance.now();
    postMessage({kind: 'progress', index, total: manifest.commands.length, name: command.name});
    postMessage({kind: 'release-compilers'}); pool.close();
    const result = lld ? await invokeEmscripten({module: lld.module, runtime: lld.runtime, program: 'wasm-ld', layers,
      files: rows.map(row => ({path: row.output, bytes: lookup(root, row.output).data})),
      args: lldArgs(command.args), output: command.output}) : await invoke(module, root, command.args);
    if (lld) insert(root, command.output, fileView(result.bytes));
    if (result.status !== 0) throw Error(`${command.name}: exit ${result.status}\n${result.log.join('\n')}`);
    const bytes = lookup(root, command.output)?.data;
    if (!bytes) throw Error('The linker produced no game');
    if (!clang) equal(lookup(root, command.expected).data, bytes, command.output);
    const row = {name: command.name, args: lld ? lldArgs(command.args) : command.args, output: command.output, bytes: bytes.length,
      sha256: await hash(bytes), seconds: (performance.now() - before) / 1000, status: result.status, memoryBytes: result.memoryBytes, log: result.log};
    rows.push(row);
    postMessage({kind: 'unit', index, total: manifest.commands.length, ...row});
    const game = lookup(root, manifest.commands.at(-1).output).data;
    if (clang) {
      const exports = new Set(WebAssembly.Module.exports(await WebAssembly.compile(game)).map(row => row.name));
      for (const name of command.args.flatMap((arg, index) => arg === '--export' ? [command.args[index+1]] : []))
        if (!exports.has(name) && !(name === 'main' && exports.has('__main_argc_argv'))) throw Error('Missing game export: ' + name);
    }
    const runtime = lookup(root, 'runtime.mjs').data.slice();
    const assets = manifest.assets.map(name => ({name, bytes: lookup(root, 'assets/' + name).data.slice()}));
    postMessage({kind: 'complete', manifest: expected, compilerManifest: expectedManifest, commands: rows,
                 seconds: (performance.now() - started) / 1000, compileSeconds: (performance.now() - compileStarted) / 1000, workerCount: data.workerCount, game, runtime, assets},
                [game.buffer, runtime.buffer, ...assets.map(asset => asset.bytes.buffer)]);
  } catch (error) {
    postMessage({kind: 'error', error: String(error), seconds: (performance.now() - started) / 1000});
  } finally {pool.close();}
};
