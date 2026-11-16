import assert from 'node:assert/strict';
import wabtFactory from 'wabt';
import {runWasiProcess, supportsProcessReuse} from '../web/wasi_process.mjs';
import {CompilePool} from '../web/compile_pool.mjs';
const wabt = await wabtFactory();

async function guest(helpers = true) {
  const source = `(module
    (import "wasi_snapshot_preview1" "observe" (func $observe (param i32 i32 i32)))
    (memory (export "memory") 1)
    (global $stack (mut i32) (i32.const 60000))
    (data (i32.const 0) "\\11")
    ${helpers ? `(func (export "__cppgm_wasi_stack_pointer") (result i32) global.get $stack)
    (func (export "__cppgm_wasi_restore_stack_pointer") (param i32) local.get 0 global.set $stack)
    (func (export "__cppgm_wasi_heap_break") (result i32)
      i32.const 4 i32.load i32.eqz if
        i32.const 4 memory.size i32.const 65536 i32.mul i32.store
      end i32.const 4 i32.load)` : ''}
    (func (export "_start")
      i32.const 0 i32.load8_u global.get $stack memory.size call $observe
      memory.size i32.const 2 i32.lt_u if i32.const 1 memory.grow drop end
      i32.const 4 i32.const 131072 i32.store
      i32.const 0 i32.const 34 i32.store8
      i32.const 65536 i32.const 51 i32.store8
      i32.const 59984 global.set $stack))`;
  const parsed = wabt.parseWat('process.wat', source);
  try {return await WebAssembly.compile(parsed.toBinary({}).buffer);}
  finally {parsed.destroy();}
}

const module = await guest(), seen = [], instances = [];
assert(supportsProcessReuse(module));
let invocationCount = 0;
function invocation(fail = false) {
  const owner = ++invocationCount;
  return {
    wasiImport: {observe: (...values) => seen.push([owner, ...values])},
    start(instance) {
      instances.push(instance);
      if (fail) throw Error('command trapped');
      const bytes = new Uint8Array(instance.exports.memory.buffer);
      assert.equal(bytes[0], 17, 'initial data was not restored');
      assert.equal(bytes[65536] || 0, 0, 'a previous heap write survived reset');
      instance.exports._start(); return 0;
    },
  };
}
assert.equal((await runWasiProcess(module, invocation())).status, 0);
assert.equal((await runWasiProcess(module, invocation())).memoryBytes, 2 * 65536);
assert.equal(instances[0], instances[1], 'the compiler instance was recreated');
assert.deepEqual(seen, [[1, 17, 60000, 1], [2, 17, 60000, 2]], 'imports or the stack kept process state');
await assert.rejects(runWasiProcess(module, invocation(true)), /command trapped/);
await runWasiProcess(module, invocation());
assert.notEqual(instances[2], instances[3], 'a failed process was reused');

const ordinary = await guest(false);
assert.equal(supportsProcessReuse(ordinary), false);
const before = instances.length;
await runWasiProcess(ordinary, invocation()); await runWasiProcess(ordinary, invocation());
assert.notEqual(instances[before], instances[before + 1], 'ordinary commands must get fresh instances');
for (let i = 0; i < 20; i++)
  assert.equal((await runWasiProcess(module, invocation())).memoryBytes, 2 * 65536, 'heap capacity grew across resets');
const port = {postMessage() {queueMicrotask(() => port.onmessage({data: {kind: 'ready'}}));}, close() {}};
const pool = new CompilePool([port], {recycleEvery: 1});
await pool.initialize(module, []);
assert.equal(pool.recycleEvery, 0, 'a resettable process still discarded its worker');
await pool.initialize(ordinary, []);
assert.equal(pool.recycleEvery, 1, 'an older compiler lost its memory limit');
await pool.initialize(module, [], {runtime: 'clang'});
assert.equal(pool.recycleEvery, 1, 'the Emscripten host reused native process globals');
pool.close();
console.log('PASS: process reset restores data, heap, stack and imports; traps retire instances and older compilers stay isolated');
