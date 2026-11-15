// Both compilers consume the same frozen source, SDK and optimization level.
// These C files are compiled as C++ by OpenLara's upstream web build too.
export function clangCompileArgs(args) {
  return ['-x', 'c++', '-nostdinc++', '-isystem', 'emscripten/cache/sysroot/include/c++/v1',
    '-Wno-builtin-macro-redefined', ...args];
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
    else if (arg === '--import-function') {i++; if (!result.includes('--allow-undefined')) result.push('--allow-undefined');}
    else if (arg.startsWith('-Wl,')) result.push(...arg.slice(4).split(','));
    else result.push(arg);
  }
  return result;
}
