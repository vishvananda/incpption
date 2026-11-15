import assert from 'node:assert/strict';
import {WorkflowState} from '../web/workflow_state.mjs';
import {clangCompileArgs, lldArgs} from '../web/clang_arguments.mjs';
const state=new WorkflowState();
const match=state.phase('inception','lara','match',['one.cpp']);
match.state='done';match.seconds=10;match.rows.set(0,{seconds:1});match.result={module:new Uint8Array([1])};
assert.equal(state.phase('inception','godot','match'),match,'compiler results survive a project change');
const lara=state.phase('inception','lara','game');lara.state='done';lara.seconds=4;
assert.notEqual(state.phase('inception','godot','game'),lara,'games belong to their target');
assert.equal(state.phase('inception','lara','game'),lara,'returning to a project restores its result');
assert.equal(state.completed('inception','lara'),true);
assert.equal(state.completed('inception','godot'),false);
state.invalidate('inception','lara','game');
assert.equal(state.phase('inception','lara','match'),match,'rerunning the game preserves its compiler');
assert.equal(state.phase('inception','lara','game').state,'waiting');
state.phase('inception','godot','game').state='done';
state.invalidate('inception','lara','match');
assert.equal(state.phase('inception','lara','match').state,'waiting');
assert.equal(state.phase('inception','godot','game').state,'waiting','rebuilding a compiler invalidates games that used it');
for(const [id,seconds]of [['game',10],['game-clang',20]]){const row=state.phase('game','lara',id);row.seconds=seconds;row.state='done';}
assert.equal(state.totalSeconds('game','lara',row=>row.seconds),20,'parallel workflow time is not summed');
state.invalidate('game','lara','game-clang');
assert.equal(state.phase('game','lara','game').state,'waiting','a comparison rerun starts both compilers');
assert.equal(state.phase('game','lara','game-clang').state,'waiting');
const args=clangCompileArgs(['-O3','-c','test.c','-o','build/test.o']);
assert(args.includes('-O3'));assert(args.includes('emscripten/cache/sysroot/include/c++/v1'));assert.deepEqual(args.slice(0,2),['-x','c++']);
assert.deepEqual(lldArgs(['--target=wasm32-unknown-unknown','-nostdlib','-Wl,-z,stack-size=8388608','--export-ctors','--export','main','--import-function','glClear','main.o','-o','game.wasm']),
  ['--no-entry','--export-memory','-z','stack-size=8388608','--export=__wasm_call_ctors','--export-if-defined=main','--export-if-defined=__main_argc_argv','--allow-undefined','main.o','-o','game.wasm']);
console.log('PASS: retained results, project boundaries, rerun invalidation, parallel timing and matched toolchain arguments');

const {runtimeExports}=await import('../web/game_exports.mjs');
const main=()=>42,memory={};
const original={main,memory};assert.equal(runtimeExports(original),original);
const clang={__main_argc_argv:main,memory};assert.equal(runtimeExports(clang).main(),42);assert.equal(runtimeExports(clang).memory,memory);assert.equal(clang.main,undefined);
assert.throws(()=>runtimeExports({}),/entry point/);
console.log('PASS: runtime entry-point adaptation preserves the original Wasm exports');
