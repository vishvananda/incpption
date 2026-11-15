import assert from 'node:assert/strict';
import {File,OpenFile} from '@bjorn3/browser_wasi_shim';
import {growingFileClass} from '../web/file_buffers.mjs';
const Output=growingFileClass(File,OpenFile),file=new Output(),{fd_obj:fd}=file.path_open(0,0n,0),buffers=new Set();
const chunk=new Uint8Array(8192).fill(17);
for(let index=0;index<128;index++){assert.equal(fd.fd_write(chunk).nwritten,chunk.length);buffers.add(file.storage.buffer);}
assert(buffers.size<20,'streamed writes reallocate per chunk');assert.equal(file.size,1048576n);assert(file.data.every(byte=>byte===17));
fd.fd_pwrite(new Uint8Array([9]),5n);assert.equal(file.data[5],9);assert.equal(file.size,1048576n);
fd.fd_filestat_set_size(10n);assert.equal(file.size,10n);fd.fd_filestat_set_size(100n);assert(file.data.subarray(10).every(byte=>byte===0));
const bytes=file.take();assert.equal(bytes.length,100);assert.equal(bytes.buffer.byteLength,100);assert.equal(file.size,0n);
console.log('PASS: streamed output has bounded reallocations, correct overwrite/truncate semantics and exact transferable storage');
