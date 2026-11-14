import {File, Directory, hash, fetchBytes, equal, insert, lookup, invoke, loadCompiler, shareBytes, fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';

self.onmessage = async ({data}) => {
  const started = performance.now(), pool = new CompilePool(data.ports);
  try {
    postMessage({kind: 'loading', message: 'Checking compiler and game inputs'});
    const {expectedManifest, root, seedBytes, module: seedModule, layers} = await loadCompiler('compiler/', {shareInputs: true});
    let module = seedModule;
    if (data?.compilerBytes) {
      equal(seedBytes, data.compilerBytes, 'rebuilt compiler');
      module = await WebAssembly.compile(data.compilerBytes);
    }
    const manifestBytes = await fetchBytes('game/manifest.json');
    const expected = new TextDecoder().decode(await fetchBytes('game/manifest.sha256')).trim();
    if (await hash(manifestBytes) !== expected) throw Error('game manifest hash mismatch');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.schema !== 1 || manifest.compiler_manifest !== expectedManifest)
      throw Error('game package uses a different compiler manifest');
    for (const [path, expected] of Object.entries(manifest.runner_files))
      if (await hash(await fetchBytes('game/' + path)) !== expected) throw Error(`game runner changed: ${path}`);
    let bundle = await fetchBytes('game/bundle.bin');
    if (await hash(bundle) !== manifest.bundle_sha256) throw Error('game bundle hash mismatch');
    for (const file of manifest.files) {
      const bytes = bundle.subarray(file.offset, file.offset + file.size);
      if (await hash(bytes) !== file.sha256) throw Error(`game input changed: ${file.path}`);

    }
    bundle = shareBytes(bundle);
    layers.push({files: manifest.files, bundle});
    for (const file of manifest.files) insert(root, file.path, fileView(bundle.subarray(file.offset, file.offset + file.size)));
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
