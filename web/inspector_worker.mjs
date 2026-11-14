import {loadCompiler, insert, lookup, File, encoder, invoke, hash} from './wasi_runtime.mjs';
import {disassemble} from './code_view.mjs';
let compiler;
const text = new TextDecoder();
async function run(args) {
  const result = await invoke(compiler.module, compiler.root, args);
  if (result.status) throw Error(result.log.join('\n') || `Compiler exited ${result.status}`);
  return result;
}
self.onmessage = async ({data}) => {
  try {
    compiler ??= await loadCompiler('compiler/');
    if (data.kind === 'load') {
      postMessage({kind: 'ready', files: compiler.manifest.files.filter(f => /^dev\/.*\.(cpp|h)$/.test(f.path)).map(f => f.path)});
    } else if (data.kind === 'read') {
      if (!compiler.manifest.files.some(f => f.path === data.path && /^dev\//.test(f.path))) throw Error('Unknown source file');
      postMessage({kind: 'source', path: data.path, text: text.decode(lookup(compiler.root, data.path).data)});
    } else if (data.kind === 'compile') {
      if (!['wasm', 'x86'].includes(data.target)) throw Error('Unknown target');
      if (encoder.encode(data.source).length > 16384) throw Error('Keep the editable example under 16 KiB.');
      insert(compiler.root, 'example.cpp', new File(encoder.encode(data.source)));
      const flags = data.target === 'wasm'
        ? ['--target=wasm32-wasip1', '--sysroot=sysroot', '-resource-dir=resource', '-std=c++11']
        : compiler.manifest.x86_flags.filter(flag => flag !== '-nostdinc');
      const common = [...flags, '-O3', '-g0', '-fno-exceptions'];
      const start = performance.now();
      await run([...common, '-c', 'example.cpp', '-o', 'example.o']);
      // This is an optional output view, never an intermediate used to produce
      // the object. -g0/.lowir selects the same object dialect and typed facts.
      await run([...common, '--emit-lowir', 'example.cpp', '-o', 'example.lowir']);
      const object = lookup(compiler.root, 'example.o').data;
      const generated = await disassemble(object, data.target);
      let executable, executionDiagnostic;
      if (data.target === 'wasm' && data.run) {
        try {
          await run([...flags, '-nostdlib', '--export', 'answer', 'example.o', '-o', 'example.wasm']);
          executable = lookup(compiler.root, 'example.wasm').data;
        } catch (error) {executionDiagnostic = String(error);}
      }
      const result = {kind: 'compiled', target: data.target, source: data.source,
        lowir: text.decode(lookup(compiler.root, 'example.lowir').data), generated,
        seconds: (performance.now() - start) / 1000, sha256: await hash(object), object, executable, executionDiagnostic};
      postMessage(result, [object.buffer, ...(executable ? [executable.buffer] : [])]);
    }
  } catch (error) {postMessage({kind: 'error', error: String(error)});}
};
