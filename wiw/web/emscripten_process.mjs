import {memoryImage, restoreMemory} from './memory_image.mjs';
// The pinned single-threaded Clang has a fixed function table and function-only
// imports. Keep its Wasm instance warm, but give every invocation a fresh JS
// runtime/FS and restore the memory image from before constructors ran.
const processes = new WeakMap();

export function supportsEmscriptenProcessReuse(module, program) {
  if (program !== 'clang++') return false;
  const exports = new Map(WebAssembly.Module.exports(module).map(row => [row.name, row.kind]));
  return exports.get('memory') === 'memory' &&
    ['emscripten_stack_get_current', '_emscripten_stack_restore', 'emscripten_stack_init'].every(name => exports.get(name) === 'function') &&
    WebAssembly.Module.imports(module).every(row => row.kind === 'function');
}

export function emscriptenInstance(module, imports, program) {
  if (!supportsEmscriptenProcessReuse(module, program)) return new WebAssembly.Instance(module, imports);
  let state = processes.get(module);
  if (state) {
    state.active = imports;
    const memory = new Uint8Array(state.instance.exports.memory.buffer);
    restoreMemory(memory, state.initial);
    state.instance.exports._emscripten_stack_restore(state.stack);
  } else {
    state = {active: imports};
    const dispatch = {};
    for (const row of WebAssembly.Module.imports(module)) {
      const namespace = dispatch[row.module] ||= {};
      namespace[row.name] = (...args) => state.active[row.module][row.name](...args);
    }
    state.instance = new WebAssembly.Instance(module, dispatch);
    const memory = new Uint8Array(state.instance.exports.memory.buffer);
    if (typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer)
      throw Error('Reusable Clang processes require unshared memory');
    state.initial = memoryImage(memory);
    state.stack = state.instance.exports.emscripten_stack_get_current();
    processes.set(module, state);
  }
  return state.instance;
}

export function finishEmscriptenProcess(module, succeeded) {
  const state = processes.get(module);
  if (state) state.active = null;
  if (!succeeded) processes.delete(module);
}
