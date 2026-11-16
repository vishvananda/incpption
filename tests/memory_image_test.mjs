import assert from 'node:assert/strict';
import {memoryImage, restoreMemory} from '../web/memory_image.mjs';
for (const data of [new Uint8Array(32), Uint8Array.from([0,0,17,0,23,0,0]), Uint8Array.from([19,0,0,29])]) {
  const image=memoryImage(data), memory=new Uint8Array(data.length+16); memory.fill(71);
  restoreMemory(memory,image);
  assert.deepEqual(memory.slice(0,data.length),data);
  assert(memory.slice(data.length).every(v=>v===0));
  assert.equal(image.bytes.length,data.some(v=>v!==0)?[...data].findLastIndex(v=>v!==0)-[...data].findIndex(v=>v!==0)+1:0);
}
const initial=new Uint8Array(32);initial[16]=42;
const image=memoryImage(initial),memory=new Uint8Array(96);memory.fill(71);
restoreMemory(memory,image,64);
assert.equal(image.bytes.length,1,'zero stack/BSS pages were retained');
assert.deepEqual(memory.slice(0,32),initial);assert(memory.slice(32,64).every(v=>v===0));assert(memory.slice(64).every(v=>v===71));
console.log('PASS: compact reset images restore leading/trailing zeros, stack and data within the used heap');
