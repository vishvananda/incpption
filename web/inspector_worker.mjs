import {loadCompiler, insert, lookup, File, encoder, invoke, hash, fileView} from './wasi_runtime.mjs';
import {loadLLVM} from './llvm_package.mjs';
import {loadGamePackage} from './game_package.mjs';
import {disassemble} from './code_view.mjs';
let compiler, llvm;
const projects=new Map();
const isProject=id=>['lara','doom','godot'].includes(id);
const text = new TextDecoder();
async function run(args, sourceDateEpoch) {
  const result = await invoke(compiler.module, compiler.root, args, sourceDateEpoch);
  if (result.status) throw Error(result.log.join('\n') || `Compiler exited ${result.status}`);
  return result;
}
function compileFlags(args, source) {
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if(args[i]==='-o'){i++;continue;}
    if(args[i]==='-c'||args[i]===source)continue;
    flags.push(args[i]);
  }
  return flags;
}
self.onmessage = async ({data}) => {
  try {
    compiler ??= await loadCompiler('compiler/', {inputProfile: 'none'});
    await compiler.ensureInputs((isProject(data.project)||data.project==='llvm') ? 'none' : data.target === 'x86' ? 'all' : 'wasm');
    if (data.kind !== 'compile') return;
    if (!['wasm', 'x86'].includes(data.target) || !isProject(data.project)&&!['cppgm','llvm','example'].includes(data.project))
      throw Error('Unknown source project or target');
    let path = data.path, flags, sourceDateEpoch;
    if (data.project === 'example') {
      if (encoder.encode(data.source).length > 16384) throw Error('Keep the editable example under 16 KiB.');
      path = 'example.cpp';
      insert(compiler.root, path, new File(encoder.encode(data.source)));
      flags = data.target === 'wasm'
        ? ['--target=wasm32-wasip1', '--sysroot=sysroot', '-resource-dir=resource', '-std=c++11']
        : compiler.manifest.x86_flags;
      flags = [...flags, '-O3', '-fno-exceptions'];
    } else if (data.project === 'llvm') {
      if (data.target !== 'wasm') throw Error('clang uses its frozen WebAssembly SDK.');
      if (!llvm) {
        llvm = await loadLLVM(compiler);
        for (const layer of llvm.layers) for (const file of layer.files)
          insert(compiler.root, file.path, fileView(layer.bundle.subarray(file.offset, file.offset + file.size)));
      }
      const command = llvm.manifest.commands.find(command => command.source === path);
      if (!command) throw Error('Choose a clang source file. Headers are inputs.');
      flags = compileFlags(command.args,path);
    } else if (isProject(data.project)) {
      if (data.target !== 'wasm') throw Error('This project uses the supplied WebAssembly SDK.');
      if(!projects.has(data.project))projects.set(data.project,await loadGamePackage(compiler,{prefix:'projects/'+data.project+'/'}));
      const game=projects.get(data.project);sourceDateEpoch=game.manifest.source_date_epoch;
      const command = game.manifest.commands.find(command => command.source === path);
      if (!command || !command.args.includes('-c')) throw Error('Choose a game source file. Headers are inputs.');
      flags = compileFlags(command.args,path);
    } else {
      if (!compiler.manifest.sources.includes(path)) throw Error('Choose a compiler source file. Headers are inputs.');
      flags = data.target === 'wasm' ? compiler.manifest.flags : [...compiler.manifest.x86_flags, '-O3'];
    }
    const start = performance.now();
    const common = [...flags, '-g0'];
    await run([...common, '-c', path, '-o', 'inspection.o'],sourceDateEpoch);
    // This view is never a transport used to produce the object.
    const assembly=/\.[Ss]$/.test(path);
    let lowir=assembly?'; Raw WebAssembly assembly is assembled directly and has no LowIR stage.\n':null;
    if(!assembly){
      const viewFlags=common.filter(flag=>!flag.startsWith('-W')&&!flag.startsWith('-fdebug-')&&!flag.startsWith('-ffile-prefix-map=')&&!flag.startsWith('-fvisibility=')&&!['-pipe','-fno-math-errno','-fomit-frame-pointer','-fno-omit-frame-pointer','-fno-unroll-loops','-fno-inline-functions','-fno-color-diagnostics'].includes(flag));
      try{await run([...viewFlags,'--emit-lowir',path,'-o','inspection.lowir'],sourceDateEpoch);lowir=text.decode(lookup(compiler.root,'inspection.lowir').data);}
      catch(error){lowir='; LowIR view unavailable for this recipe. The WebAssembly tab shows the actual compiled object.\n; '+String(error).replaceAll('\n','\n; ')+'\n';}
    }
    const stored=lookup(compiler.root,'inspection.o');
    const object=stored.take?stored.take():stored.data;
    insert(compiler.root,'inspection.o',fileView(object));
    const generated = await disassemble(object, data.target);
    let executable, executionDiagnostic;
    if (data.project === 'example' && data.target === 'wasm') {
      try {
        await run([...flags, '-nostdlib', '--export', 'answer', 'inspection.o', '-o', 'inspection.wasm']);
        const linked=lookup(compiler.root,'inspection.wasm');executable=linked.take?linked.take():linked.data;
      } catch (error) {executionDiagnostic = String(error);}
    }
    const result = {kind: 'compiled', request: data.request, path, project: data.project,
      target: data.target, lowir, generated,
      seconds: (performance.now() - start) / 1000, sha256: await hash(object), object, executable, executionDiagnostic};
    postMessage(result, [object.buffer, ...(executable ? [executable.buffer] : [])]);
  } catch (error) {postMessage({kind: 'error', request: data.request, error: String(error)});}
};
