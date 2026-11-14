import {loadCompiler, insert, lookup, File, encoder, invoke, hash, fileView} from './wasi_runtime.mjs';
import {loadLLVM} from './llvm_package.mjs';
import {loadGamePackage} from './game_package.mjs';
import {disassemble} from './code_view.mjs';
let compiler, game, llvm;
const text = new TextDecoder();
async function run(args) {
  const result = await invoke(compiler.module, compiler.root, args);
  if (result.status) throw Error(result.log.join('\n') || `Compiler exited ${result.status}`);
  return result;
}
function compileFlags(args) {
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-o') {i++; continue;}
    flags.push(args[i]);
  }
  return flags;
}
self.onmessage = async ({data}) => {
  try {
    compiler ??= await loadCompiler('compiler/', {inputProfile: 'none'});
    await compiler.ensureInputs(['game', 'llvm'].includes(data.project) ? 'none' : data.target === 'x86' ? 'all' : 'wasm');
    if (data.kind !== 'compile') return;
    if (!['wasm', 'x86'].includes(data.target) || !['game', 'cppgm', 'llvm', 'example'].includes(data.project))
      throw Error('Unknown source project or target');
    let path = data.path, flags;
    if (data.project === 'example') {
      if (encoder.encode(data.source).length > 16384) throw Error('Keep the editable example under 16 KiB.');
      path = 'example.cpp';
      insert(compiler.root, path, new File(encoder.encode(data.source)));
      flags = data.target === 'wasm'
        ? ['--target=wasm32-wasip1', '--sysroot=sysroot', '-resource-dir=resource', '-std=c++11']
        : compiler.manifest.x86_flags;
      flags = [...flags, '-O3', '-fno-exceptions'];
    } else if (data.project === 'llvm') {
      if (data.target !== 'wasm') throw Error('LLVM uses its frozen WebAssembly SDK.');
      if (!llvm) {
        llvm = await loadLLVM(compiler);
        for (const layer of llvm.layers) for (const file of layer.files)
          insert(compiler.root, file.path, fileView(layer.bundle.subarray(file.offset, file.offset + file.size)));
      }
      const command = llvm.manifest.commands.find(command => command.source === path);
      if (!command) throw Error('Choose an LLVM source file. Headers are inputs.');
      flags = compileFlags(command.args);
    } else if (data.project === 'game') {
      if (data.target !== 'wasm') throw Error('OpenLara uses the supplied WebAssembly SDK.');
      game ??= await loadGamePackage(compiler);
      const command = game.manifest.commands.find(command => command.name === path);
      if (!command || !command.args.includes('-c')) throw Error('Choose a game source file. Headers are inputs.');
      flags = compileFlags(command.args);
    } else {
      if (!compiler.manifest.sources.includes(path)) throw Error('Choose a compiler source file. Headers are inputs.');
      flags = data.target === 'wasm' ? compiler.manifest.flags : [...compiler.manifest.x86_flags, '-O3'];
    }
    const start = performance.now();
    const common = [...flags, '-g0'];
    await run([...common, '-c', path, '-o', 'inspection.o']);
    // This view is never a transport used to produce the object.
    await run([...common, '--emit-lowir', path, '-o', 'inspection.lowir']);
    const object = lookup(compiler.root, 'inspection.o').data;
    const generated = await disassemble(object, data.target);
    let executable, executionDiagnostic;
    if (data.project === 'example' && data.target === 'wasm') {
      try {
        await run([...flags, '-nostdlib', '--export', 'answer', 'inspection.o', '-o', 'inspection.wasm']);
        executable = lookup(compiler.root, 'inspection.wasm').data;
      } catch (error) {executionDiagnostic = String(error);}
    }
    const result = {kind: 'compiled', request: data.request, path, project: data.project,
      target: data.target, lowir: text.decode(lookup(compiler.root, 'inspection.lowir').data), generated,
      seconds: (performance.now() - start) / 1000, sha256: await hash(object), object, executable, executionDiagnostic};
    postMessage(result, [object.buffer, ...(executable ? [executable.buffer] : [])]);
  } catch (error) {postMessage({kind: 'error', request: data.request, error: String(error)});}
};
