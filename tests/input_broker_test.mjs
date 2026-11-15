import assert from 'node:assert/strict';
import {InputBroker} from '../web/input_broker.mjs';
let requests=0;
globalThis.location={href:'https://site.test/index.html',origin:'https://site.test'};
globalThis.crossOriginIsolated=true;
globalThis.fetch=async()=>{requests++;await new Promise(resolve=>setTimeout(resolve,10));return new Response(new Uint8Array([1,2,3]));};
const broker=new InputBroker(),a=new MessageChannel(),b=new MessageChannel();broker.connect(a.port1);broker.connect(b.port1);
function request(port,path){return new Promise(resolve=>{port.onmessage=({data})=>resolve(data);port.postMessage({id:1,path});});}
const [first,second]=await Promise.all([request(a.port2,'/inputs.bin'),request(b.port2,'/inputs.bin')]);
assert.equal(requests,1,'simultaneous requests downloaded the same input twice');
assert(first.bytes.buffer instanceof SharedArrayBuffer);first.bytes[0]=9;assert.equal(second.bytes[0],9,'the two pools received copied input buffers');
assert.equal((await request(a.port2,'https://elsewhere.test/input')).error.includes('site origin'),true);
broker.close();a.port2.close();b.port2.close();assert.equal(broker.cache.size,0);assert.equal(broker.abort.signal.aborted,true);
console.log('PASS: comparison input downloads coalesce, share memory, reject other origins and release on cancel');
