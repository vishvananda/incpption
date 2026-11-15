import {loadCompiler, insert, fileView, lookup, invoke, hash} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';
self.onmessage = async ({data}) => {
  const started = performance.now(), pool = new CompilePool(data.ports, data);
  try {
    postMessage({kind: 'loading', message: 'Loading cppgm source and SDK'});
    const compiler = await loadCompiler('compiler/', {shareInputs: true});
    const {manifest, root, layers} = compiler;
    const names = [...manifest.sources, 'Link cppgm'];
    postMessage({kind: 'ready', sources: names, workerCount: data.workerCount});
    const flags = [...manifest.flags, '-matomics', '-mno-bulk-memory', '-fno-strict-aliasing',
      '-fexceptions', '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false',
      '-Wno-builtin-macro-redefined', '-isystem', 'sysroot/include/wasm32-wasip1/eh/c++/v1'];
    await pool.initialize(await WebAssembly.compile(data.compilerBytes), layers,
      {runtime: data.runtime, program: 'clang++'});
    const outputs = [];
    await pool.run(manifest.sources.map((source, index) => {
      const output = 'clang-cppgm/' + source.replaceAll('/', '__') + '.o';
      return {source, output, args: [...flags, '-c', source, '-o', output], progress: {index, name: source}};
    }), async (result, command, index) => {
      insert(root, command.output, fileView(result.bytes)); outputs[index] = command.output;
      postMessage({kind: 'unit', index, name: command.source, bytes: result.bytes.length,
        memoryBytes: result.memoryBytes, seconds: result.seconds, matched: false});
    });
    postMessage({kind: 'release-compilers'}); pool.close();
    const index = manifest.sources.length, before = performance.now();
    postMessage({kind: 'progress', index, name: names[index]});
    const result = await invoke(compiler.module, root, [...manifest.flags, ...outputs,
      ...manifest.link_flags, '-o', 'clang-cppgm/cppgm.wasm']);
    if (result.status) throw Error(result.log.join('\n') || 'cppgm link failed');
    const bytes = lookup(root, 'clang-cppgm/cppgm.wasm').data;
    postMessage({kind: 'unit', index, name: names[index], bytes: bytes.length,
      seconds: (performance.now()-before)/1000, memoryBytes: result.memoryBytes, matched: false});
    // Equality is checked in the next phase, when this compiler rebuilds cppgm.
    postMessage({kind: 'complete', module: bytes, seconds: (performance.now()-started)/1000,
      sha256: await hash(bytes)}, [bytes.buffer]);
  } catch (error) {postMessage({kind: 'error', error: String(error), stack: error.stack});}
  finally {pool.close();}
};
