import assert from 'node:assert/strict';
import wabtFactory from 'wabt';
import {emscriptenInstance, finishEmscriptenProcess, supportsEmscriptenProcessReuse} from '../web/emscripten_process.mjs';
import {CompilePool} from '../web/compile_pool.mjs';
const wabt = await wabtFactory();
const source = `(module
  (import "env" "observe" (func $observe (param i32)))
  (memory (export "memory") 1)
  (global $stack (mut i32) (i32.const 60000))
  (data (i32.const 0) "\\11")
  (func (export "emscripten_stack_init"))
  (func (export "emscripten_stack_get_current") (result i32) global.get $stack)
  (func (export "_emscripten_stack_restore") (param i32) local.get 0 global.set $stack)
  (func (export "run")
    i32.const 0 i32.load8_u call $observe
    memory.size i32.const 2 i32.lt_u if i32.const 1 memory.grow drop end
    i32.const 0 i32.const 34 i32.store8
    i32.const 65536 i32.const 51 i32.store8
    i32.const 59984 global.set $stack))`;
const parsed = wabt.parseWat('clang-process.wat', source);
const module = await WebAssembly.compile(parsed.toBinary({}).buffer); parsed.destroy();
assert(supportsEmscriptenProcessReuse(module, 'clang++'));
assert(!supportsEmscriptenProcessReuse(module, 'wasm-ld'));
const observed = [];
function invoke(owner) {
  const instance = emscriptenInstance(module, {env: {observe: value => observed.push([owner, value])}}, 'clang++');
  assert.equal(instance.exports.emscripten_stack_get_current(), 60000);
  const bytes = new Uint8Array(instance.exports.memory.buffer);
  assert.equal(bytes[0], 17); assert.equal(bytes[65536] || 0, 0, 'a preceding process retained heap data');
  instance.exports.run(); finishEmscriptenProcess(module, true); return instance;
}
const first = invoke(1);
for (let i = 2; i <= 20; i++) {
  assert.equal(invoke(i), first, 'Clang recreated its Wasm instance');
  assert.equal(first.exports.memory.buffer.byteLength, 131072, 'reserved memory leaked across commands');
}
assert.deepEqual(observed, Array.from({length: 20}, (_, i) => [i + 1, 17]), 'imports kept an old JS runtime');
finishEmscriptenProcess(module, false);
assert.notEqual(invoke(21), first, 'a failed command kept its Wasm state');
const imports = {env: {observe() {}}};
assert.notEqual(emscriptenInstance(module, imports, 'wasm-ld'), emscriptenInstance(module, imports, 'wasm-ld'));
const port = {postMessage() {queueMicrotask(() => port.onmessage({data: {kind: 'ready'}}));}, close() {}};
const pool = new CompilePool([port], {recycleEvery: 1});
await pool.initialize(module, [], {program: 'clang++'}); assert.equal(pool.recycleEvery, 0);
await pool.initialize(module, [], {program: 'wasm-ld'}); assert.equal(pool.recycleEvery, 1);
await pool.initialize(null, [], {program: 'clang++', seed: 'clang'}); assert.equal(pool.recycleEvery, 1);
const negotiated = {postMessage() {queueMicrotask(() => negotiated.onmessage({data: {kind: 'ready', reuseProcess: true}}));}, close() {}};
const child = new CompilePool([negotiated], {recycleEvery: 1});
await child.initialize(null, [], {program: 'clang++', seed: 'clang'}); assert.equal(child.recycleEvery, 0, 'worker-loaded seeds lost process reuse');
child.close();
pool.close();
console.log('PASS: Clang reuses Wasm memory and execution state with fresh imports, stack and heap; failures retire processes');
