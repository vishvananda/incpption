import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bundleLayers} from '../web/bundle_layers.mjs';
import {archive} from '../web/ar.mjs';
const bytes = text => new TextEncoder().encode(text), hash = data => createHash('sha256').update(data).digest('hex');
const a = bytes('source'), b = bytes('headers'), requested = [], cache = new Map();
const rows = [{path:'source.cpp',offset:0,size:a.length,sha256:hash(a)}, {path:'x86/headers',offset:a.length,size:b.length,sha256:hash(b)},
  {path:'empty',offset:a.length+b.length,size:0,sha256:hash(bytes(''))}];
const transport = {schema:1,sha256:'bundle identity',bytes:a.length+b.length,chunks:[
  {path:'chunks/a.bin',offset:0,size:a.length,sha256:hash(a)}, {path:'chunks/b.bin',offset:a.length,size:b.length,sha256:hash(b)}]};
const manifest = {bundle_sha256:transport.sha256,files:rows};
globalThis.crossOriginIsolated = true;
globalThis.fetch = async url => {
  requested.push(url);
  return url.endsWith('transport.json') ? Response.json(transport) : new Response(url.endsWith('a.bin') ? a : b);
};
const first = await bundleLayers('/profile/', manifest, {shared:true,cache,select:f=>f.path==='source.cpp'});
assert.equal(first.length,1);assert.ok(first[0].bundle.buffer instanceof SharedArrayBuffer);
assert.deepEqual(new Uint8Array(first[0].bundle),a);
assert.equal(requested.filter(p=>p.endsWith('b.bin')).length,0,'x86 input fetched for WASI-only request');
const again = await bundleLayers('/profile/',manifest,{shared:true,cache,select:f=>f.path==='source.cpp'});
assert.equal(again[0].bundle.buffer,first[0].bundle.buffer,'cached shared inputs copied');
assert.equal(requested.filter(p=>p.endsWith('a.bin')).length,1);
const rest = await bundleLayers('/profile/',manifest,{select:f=>f.path!=='source.cpp'});
assert.equal(rest[0].files[1].size,0);assert.equal(rest[0].files[0].offset,0);
await assert.rejects(()=>bundleLayers('/profile/',{...manifest,files:[{...rows[0],size:100}]}),/bounds/);
await assert.rejects(()=>bundleLayers('/profile/',{...manifest,files:[{...rows[0],sha256:'bad'}]}),/checksum/);
await assert.rejects(()=>bundleLayers('/profile/',{...manifest,files:[{...rows[0],path:'../escape'}]}),/path/);
// Independent archive fixture, including BSD long names and odd-byte padding.
const members = [{name:'a.o',bytes:bytes('abc')},{name:'long-member-name.cpp.o',bytes:bytes('abcd')}];
let golden = '!<arch>\n';
for(const member of members) {
  const size = member.name.length+member.bytes.length;
  golden += (`#1/${member.name.length}`).padEnd(16)+'0'.padEnd(12)+'0'.padEnd(6)+'0'.padEnd(6)+'100644'.padEnd(8)+String(size).padEnd(10)+'`\n'+member.name+new TextDecoder().decode(member.bytes)+(size%2?'\n':'');
}
assert.deepEqual(archive(members),bytes(golden));
console.log('PASS: selective input loading, shared cache identity, corrupt inputs and BSD archive bytes');
const big=bytes('a source larger than one chunk'),splitAt=10;
const split={schema:1,split_files:true,sha256:hash(big),bytes:big.length,chunks:[
 {path:'chunks/one.bin',offset:0,size:splitAt,sha256:hash(big.subarray(0,splitAt))},
 {path:'chunks/two.bin',offset:splitAt,size:big.length-splitAt,sha256:hash(big.subarray(splitAt))}]};
globalThis.fetch=async url=>url.endsWith('transport.json')?Response.json(split):new Response(url.endsWith('one.bin')?big.subarray(0,splitAt):big.subarray(splitAt));
const large={bundle_sha256:hash(big),files:[{path:'generated.cpp',offset:0,size:big.length,sha256:hash(big)}]};
const joined=await bundleLayers('/large/',large,{shared:true});
assert.deepEqual(new Uint8Array(joined[0].bundle),big);assert(joined[0].bundle.buffer instanceof SharedArrayBuffer);
assert.equal(joined[0].files[0].offset,0);
await assert.rejects(()=>bundleLayers('/large/',{...large,files:[{...large.files[0],sha256:'0'.repeat(64)}]}),/checksum/);
console.log('PASS: large generated files reconstruct in shared storage and reject corruption');
