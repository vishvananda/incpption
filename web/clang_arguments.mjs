// Both compilers consume the same frozen source, SDK and optimization level.
// C, C++ and assembly keep the language recorded by the project build.
export function clangCompileArgs(args, language='c++', sourceDateEpoch, wasmLongjmp=false) {
  const flags=['-Wno-builtin-macro-redefined','-Wno-unused-command-line-argument','-fintegrated-cc1'];
  if(wasmLongjmp&&language!=='assembler'&&language!=='assembler-with-cpp')flags.push('-mexception-handling','-mllvm','-wasm-enable-sjlj','-mllvm','-wasm-use-legacy-eh');
  if(language==='c++')flags.push('-nostdinc++','-isystem','emscripten/cache/sysroot/include/c++/v1');
  if(sourceDateEpoch!==undefined){
    const date=new Date(sourceDateEpoch*1000);
    const month=date.toLocaleString('en-US',{month:'short',timeZone:'UTC'});
    flags.push('-D__DATE__='+JSON.stringify(`${month} ${String(date.getUTCDate()).padStart(2,' ')} ${date.getUTCFullYear()}`),'-D__TIME__='+JSON.stringify(date.toISOString().slice(11,19)));
  }
  return ['-x',language,...flags,...args];
}
export function lldArgs(args) {
  const result = ['--no-entry', '--export-memory'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--target=') || arg === '-nostdlib') continue;
    if (arg === '--export-ctors') result.push('--export=__wasm_call_ctors');
    else if (arg === '--export') {
      const name = args[++i];
      if (name === 'main') result.push('--export-if-defined=main', '--export-if-defined=__main_argc_argv');
      else result.push('--export=' + name);
    }
    else if (arg === '--import-function') {i++; if (!result.includes('--allow-undefined-file=browser-imports.txt')) result.push('--allow-undefined-file=browser-imports.txt');}
    else if (arg.startsWith('-Wl,')) result.push(...arg.slice(4).split(','));
    else result.push(arg);
  }
  return result;
}

// Compiler exports also include small assembly host helpers outside dev/.
export function clangSourceLanguage(source) {
  return source.endsWith('.S') ? 'assembler-with-cpp' : source.endsWith('.s') ? 'assembler' : source.endsWith('.c') ? 'c' : 'c++';
}
export function clangAssemblyArgs(args, source, output) {
  let target = 'wasm32-unknown-emscripten';
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--target=')) target = args[i].slice(9);
    else if (args[i] === '--target' || args[i] === '-target') target = args[++i];
  }
  const features = ['-target-feature', args.includes('-mno-bulk-memory') ? '-bulk-memory' : '+bulk-memory'];
  if (args.includes('-matomics')) features.push('-target-feature', '+atomics');
  return ['-cc1as', '-triple', target, ...features, '-filetype', 'obj', '-o', output, source];
}
