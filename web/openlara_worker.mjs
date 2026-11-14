import {Directory, hash, equal, insert, lookup, invoke, loadCompiler, fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';
import {loadGamePackage} from './game_package.mjs';

self.onmessage = async ({data}) => {
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
    const {manifest, expected} = await loadGamePackage(compiler, {shared: true});
    root.contents.set('build', new Directory([]));
    await pool.initialize(module, layers);
    const tasks = manifest.commands.slice(0, -1).map((command, index) => ({...command,
      progress: {index, total: manifest.commands.length, name: command.name}}));
    const rows = await pool.run(tasks, async (result, command, index) => {
      equal(lookup(root, command.expected).data, result.bytes, command.output);
      insert(root, command.output, fileView(result.bytes));
      const row = {name: command.name, args: command.args, output: command.output, bytes: result.bytes.length,
        sha256: await hash(result.bytes), seconds: result.seconds, status: result.status,
        memoryBytes: result.memoryBytes, log: result.log};
      postMessage({kind: 'unit', index, total: manifest.commands.length, ...row});
      return row;
    });
    const command = manifest.commands.at(-1), index = tasks.length, before = performance.now();
    postMessage({kind: 'progress', index, total: manifest.commands.length, name: command.name});
    const result = await invoke(module, root, command.args);
    if (result.status !== 0) throw Error(`${command.name}: exit ${result.status}\n${result.log.join('\n')}`);
    const bytes = lookup(root, command.output)?.data;
    if (!bytes) throw Error('The linker produced no game');
    equal(lookup(root, command.expected).data, bytes, command.output);
    const row = {name: command.name, args: command.args, output: command.output, bytes: bytes.length,
      sha256: await hash(bytes), seconds: (performance.now() - before) / 1000, ...result};
    rows.push(row);
    postMessage({kind: 'unit', index, total: manifest.commands.length, ...row});
    const game = lookup(root, manifest.commands.at(-1).output).data;
    const runtime = lookup(root, 'runtime.mjs').data.slice();
    const assets = manifest.assets.map(name => ({name, bytes: lookup(root, 'assets/' + name).data.slice()}));
    postMessage({kind: 'complete', manifest: expected, compilerManifest: expectedManifest, commands: rows,
                 seconds: (performance.now() - started) / 1000, workerCount: data.workerCount, game, runtime, assets},
                [game.buffer, runtime.buffer, ...assets.map(asset => asset.bytes.buffer)]);
  } catch (error) {
    postMessage({kind: 'error', error: String(error), seconds: (performance.now() - started) / 1000});
  } finally {pool.close();}
};
