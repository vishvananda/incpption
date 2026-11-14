import {File, Directory, encoder, hash, fetchBytes, equal, insert, lookup, invoke, loadCompiler, fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';

self.onmessage = async ({data: options}) => {
  const started = performance.now(), pool = new CompilePool(options.ports);
  try {
    const {manifest, expectedManifest, root, seedBytes, module: seedModule, layers} = await loadCompiler('compiler/', {shareInputs: true});
    let module = options.compilerBytes ? await WebAssembly.compile(options.compilerBytes) : seedModule, finalStage = 2;
    const generations = options.secondBuild ? [2, 3] : [2];
    postMessage({kind: 'ready', revision: manifest.revision, dirty: manifest.dirty,
      sourceSha256: manifest.source_sha256, manifest: expectedManifest, sources: manifest.sources,
      seedBytes: seedBytes.length, seedSha256: await hash(seedBytes), workerCount: options.workerCount,
      generations: generations.length, sharedInputs: typeof SharedArrayBuffer !== 'undefined' && layers[0].bundle.buffer instanceof SharedArrayBuffer});
    const records = [];
    let peakMemoryBytes = 0;
    for (const stage of generations) {
      finalStage = stage;
      root.contents.set(`w${stage}`, new Directory([]));
      const stageStart = performance.now();
      await pool.initialize(module, layers);
      const tasks = manifest.sources.map((source, index) => {
        const name = source.replaceAll('/', '__') + '.o';
        return {name, source, output: `out/${name}`,
          args: [...manifest.flags, '-c', source, '-o', `out/${name}`],
          progress: {stage, index, total: manifest.sources.length + 1, name: source}};
      });
      const rows = await pool.run(tasks, async (result, task, index) => {
        const output = `w${stage}/${task.name}`, actual = result.bytes;
        const expected = stage === 2 ? await fetchBytes(`compiler/inputs/w1/${task.name}`) : lookup(root, `w2/${task.name}`).data;
        equal(expected, actual, output);
        insert(root, output, fileView(actual));
        peakMemoryBytes = Math.max(peakMemoryBytes, result.memoryBytes);
        const row = {output, bytes: actual.length, sha256: await hash(actual), seconds: result.seconds,
          memoryBytes: result.memoryBytes, diagnostics: result.log};
        postMessage({kind: 'unit', stage, index, total: tasks.length + 1, name: task.source, ...row});
        return row;
      });
      const output = `w${stage}/cppgm.wasm`, before = performance.now();
      postMessage({kind: 'progress', stage, index: tasks.length, total: tasks.length + 1, name: 'link compiler'});
      const result = await invoke(module, root, [...manifest.flags,
        ...tasks.map(t => `w${stage}/${t.name}`), ...manifest.link_flags, '-o', output]);
      if (result.status !== 0) throw Error(`${output}: exit ${result.status}\n${result.log.join('\n')}`);
      const actual = lookup(root, output)?.data;
      if (!actual) throw Error('The linker produced no compiler');
      equal(stage === 2 ? seedBytes : lookup(root, 'w2/cppgm.wasm').data, actual, output);
      peakMemoryBytes = Math.max(peakMemoryBytes, result.memoryBytes);
      rows.push({output, bytes: actual.length, sha256: await hash(actual), seconds: (performance.now() - before) / 1000,
        memoryBytes: result.memoryBytes, diagnostics: result.log});
      postMessage({kind: 'unit', stage, index: tasks.length, total: tasks.length + 1, name: 'link compiler', ...rows.at(-1)});
      records.push({stage, seconds: (performance.now() - stageStart) / 1000, commands: rows});
      module = await WebAssembly.compile(actual);
      postMessage({kind: 'stage', stage, seconds: records.at(-1).seconds, peakMemoryBytes});
    }
    const x86Checks = [];
    for (const level of [0, 2]) {
      postMessage({kind: 'checking', name: `x86 floating corpus at -O${level}`});
      const output = `floating-O${level}.o`;
      const result = await invoke(module, root, [...manifest.x86_flags, `-O${level}`, '-c', 'checks/floating.cpp', '-o', output]);
      if (result.status !== 0) throw Error(`x86 corpus failed: ${result.log.join('\n')}`);
      const expected = await fetchBytes(`compiler/inputs/x86-check/checks__floating.cpp.o.O${level}.native.o`);
      const actual = lookup(root, output).data;
      equal(expected, actual, output);
      x86Checks.push({level, bytes: actual.length, sha256: await hash(actual), ...result});
      peakMemoryBytes = Math.max(peakMemoryBytes, result.memoryBytes);
    }
    insert(root, 'accepted.cpp', new File(encoder.encode('extern "C" int answer(int n){return n*7+3;}\nlong double exact=0x1.0000000000000002p0L;\n')));
    insert(root, 'rejected.cpp', new File(encoder.encode('int broken=missing_name;\n')));
    const accepted = await invoke(module, root, ['-c', 'accepted.cpp', '-o', 'accepted.o']);
    const rejected = await invoke(module, root, ['-c', 'rejected.cpp', '-o', 'rejected.o']);
    if (accepted.status !== 0 || rejected.status === 0) throw Error('Rebuilt compiler checks failed');
    const finalModule = lookup(root, `w${finalStage}/cppgm.wasm`).data;
    postMessage({kind: 'complete', manifest: expectedManifest, userAgent: navigator.userAgent,
      seconds: (performance.now() - started) / 1000, peakMemoryBytes, workerCount: options.workerCount,
      stages: records, accepted, rejected, x86Checks, module: finalModule}, [finalModule.buffer]);
  } catch (error) {postMessage({kind: 'error', error: String(error), stack: error.stack, seconds: (performance.now() - started) / 1000});}
  finally {pool.close();}
};
