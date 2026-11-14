import {loadCompiler, mountLayers, insert, lookup, fileView, invoke, hash} from './wasi_runtime.mjs';
import {loadLLVM} from './llvm_package.mjs';
import {CompilePool} from './compile_pool.mjs';
import {archive} from './ar.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
self.onmessage = async ({data}) => {
  const started = performance.now(), pool = new CompilePool(data.ports);
  try {
    postMessage({kind: 'loading', message: 'Loading LLVM source and SDK'});
    const compiler = await loadCompiler('compiler/', {inputProfile: 'none', shareInputs: true});
    const {manifest, layers} = await loadLLVM(compiler, {shared: true}), root = mountLayers(layers);
    const names = [...manifest.commands.map(command => command.source), 'Link LLD', 'Link Clang'];
    postMessage({kind: 'ready', sources: names, workerCount: data.workerCount});
    await pool.initialize(compiler.module, layers);
    const objects = new Map();
    await pool.run(manifest.commands.map((command, index) => ({...command, progress: {index, name: command.source}})),
      async (result, command, index) => {
        const sha256 = await hash(result.bytes);
        if (sha256 !== command.sha256) throw Error('LLVM object differs: ' + command.source);
        objects.set(command.output, result.bytes);
        postMessage({kind: 'unit', index, name: command.source, seconds: result.seconds, bytes: result.bytes.length,
          memoryBytes: result.memoryBytes, sha256, matched: false});
      });
    // Stop compile instances before the larger link. The page owns the workers.
    postMessage({kind: 'release-compilers'});
    pool.close();
    for (const [path, bytes] of objects) insert(root, path, fileView(bytes));
    for (const row of manifest.archives) {
      const bytes = archive(row.members.map(path => ({name: path.split('/').at(-1), bytes: objects.get(path)})));
      insert(root, row.output, fileView(bytes));
    }
    let before = performance.now(), index = manifest.commands.length;
    postMessage({kind: 'progress', index, name: names[index]});
    const linked = await invoke(compiler.module, root, manifest.lld.args);
    if (linked.status) throw Error(linked.log.join('\n') || 'LLD link failed');
    const lld = lookup(root, 'bin/lld.wasm').data;
    if (await hash(lld) !== manifest.lld.sha256) throw Error('LLD output differs');
    postMessage({kind: 'unit', index, name: names[index], seconds: (performance.now()-before)/1000,
      bytes: lld.length, memoryBytes: linked.memoryBytes, matched: false});
    // Clang is linked by the LLD we just built. Its --start-lib groups consume
    // the actual browser-produced object buffers, without indexed archives.
    for (const row of manifest.archives) {
      const parts = row.output.split('/'), name = parts.pop(); lookup(root, parts.join('/')).contents.delete(name);
    }
    index++; before = performance.now();
    postMessage({kind: 'progress', index, name: names[index]});
    const result = await invokeEmscripten({module: await WebAssembly.compile(lld),
      runtime: new URL('llvm/' + manifest.runtime.lld.path, self.location).href, program: 'wasm-ld', layers,
      files: [...objects].map(([path, bytes]) => ({path, bytes})), args: manifest.clang.args, output: 'bin/clang-lld.wasm'});
    const sha256 = await hash(result.bytes);
    if (sha256 !== manifest.clang.sha256) throw Error('Clang output differs');
    postMessage({kind: 'unit', index, name: names[index], seconds: (performance.now()-before)/1000,
      bytes: result.bytes.length, memoryBytes: result.memoryBytes, sha256, matched: false});
    postMessage({kind: 'complete', module: result.bytes,
      runtime: new URL('llvm/' + manifest.runtime.clang.path, self.location).href,
      seconds: (performance.now()-started)/1000, sha256}, [result.bytes.buffer]);
  } catch (error) {postMessage({kind: 'error', error: String(error), stack: error.stack});}
  finally {pool.close();}
};
