import {memoryImage, restoreMemory} from './memory_image.mjs';
// Qualified, single-threaded compiler commands have a static function table and
// only the host stack pointer changes outside linear memory. The source-built
// host helpers expose that pointer without changing the compiler entry point.
const processes = new WeakMap();
const stackPointer = '__cppgm_wasi_stack_pointer';
const restoreStack = '__cppgm_wasi_restore_stack_pointer';
const heapBreak = '__cppgm_wasi_heap_break';

export function supportsProcessReuse(module) {
  const exports = new Map(WebAssembly.Module.exports(module).map(row => [row.name, row.kind]));
  return exports.get('memory') === 'memory' && exports.get(stackPointer) === 'function' &&
    exports.get(restoreStack) === 'function' && exports.get(heapBreak) === 'function';
}

export async function runWasiProcess(module, wasi) {
  let state = processes.get(module);
  try {
    if (state) {
      state.active = wasi;
      // A command starts with its original data/BSS image and zeroed heap.
      // Keep the physical capacity and WebKit's per-instance execution state.
      const memory = new Uint8Array(state.instance.exports.memory.buffer);
      restoreMemory(memory, state.initial, state.usedBytes);
      state.instance.exports[restoreStack](state.stack);
    } else if (supportsProcessReuse(module)) {
      state = {active: wasi};
      const imports = Object.fromEntries(Object.keys(wasi.wasiImport).map(name =>
        [name, (...args) => state.active.wasiImport[name](...args)]));
      state.instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1: imports});
      const exports = state.instance.exports;
      if (typeof SharedArrayBuffer !== 'undefined' && exports.memory.buffer instanceof SharedArrayBuffer)
        throw Error('Reusable compiler processes require unshared memory');
      // Save an initialized logical break, not a zero that would restart the
      // allocator at the enlarged physical memory end on every invocation.
      if ((exports[heapBreak]() >>> 0) !== exports.memory.buffer.byteLength)
        throw Error('Reusable compiler has an invalid initial heap break');
      state.initial = memoryImage(new Uint8Array(exports.memory.buffer));
      state.stack = exports[stackPointer]();
      processes.set(module, state);
    } else {
      state = {instance: await WebAssembly.instantiate(module, {wasi_snapshot_preview1: wasi.wasiImport})};
    }
    const status = wasi.start(state.instance);
    if (state.initial) {
      state.usedBytes = state.instance.exports[heapBreak]() >>> 0;
      if (state.usedBytes < state.initial.capacity || state.usedBytes > state.instance.exports.memory.buffer.byteLength)
        throw Error('Reusable compiler has an invalid heap break');
    }
    return {status, memoryBytes: state.instance.exports.memory.buffer.byteLength};
  } catch (error) {
    processes.delete(module);
    throw error;
  } finally {
    // Completed commands must not retain their file descriptors or output tree.
    if (state) state.active = null;
  }
}
