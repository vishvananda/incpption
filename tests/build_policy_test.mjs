import assert from 'node:assert/strict';
import {buildPolicy, backgroundDataAllowed} from '../web/build_policy.mjs';
import {errorText} from '../web/error_text.mjs';
const desktop={userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:0,hardwareConcurrency:12};
assert.equal(buildPolicy(desktop).defaultWorkers,8);
assert.equal(buildPolicy({...desktop,hardwareConcurrency:2}).defaultWorkers,2);
for(const device of [
  {...desktop,userAgent:'iPhone',maxTouchPoints:5,hardwareConcurrency:6},
  {...desktop,maxTouchPoints:5},
  {...desktop,userAgent:'Android',platform:'Linux',maxTouchPoints:5},
  {...desktop,deviceMemory:4}
]){
  const policy=buildPolicy(device);
  assert.equal(policy.maximum,4);assert.equal(policy.defaultWorkers,2);assert.equal(policy.recycleEvery,1);
}
assert.equal(buildPolicy({...desktop,hardwareConcurrency:1}).defaultWorkers,1);
assert.equal(buildPolicy({...desktop,maxTouchPoints:1},()=>({matches:true})).lowMemory,true);
const webkit={...desktop,userAgent:'Mozilla/5.0 AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15'};
assert.equal(buildPolicy(webkit).defaultWorkers,2);assert.equal(buildPolicy(webkit).maximum,8);
assert.equal(buildPolicy({...webkit,userAgent:webkit.userAgent+' Chrome/140.0.0.0'}).defaultWorkers,8);
assert.equal(buildPolicy({...webkit,userAgent:webkit.userAgent+' Edg/140.0.0.0'}).defaultWorkers,8);
const safari=Error('WebAssembly.Instance: Out of memory');safari.stack='invokeEmscripten@https://site.test/emscripten_host.mjs:26:90';
assert.match(errorText(safari),/Out of memory/);assert.match(errorText(safari),/invokeEmscripten@/);
const chrome=Error('compile failed');assert.equal(errorText(chrome),chrome.stack);
assert.equal(errorText('plain failure'),'plain failure');assert.equal(errorText(null),'null');
console.log('PASS: phone/iPad/desktop worker budgets and Safari exception messages');

assert.equal(backgroundDataAllowed({lowMemory:true,activeBuilds:2,bytes:480*1048576}),false);
assert.equal(backgroundDataAllowed({lowMemory:true,activeBuilds:1,bytes:480*1048576}),false);
assert.equal(backgroundDataAllowed({lowMemory:true,activeBuilds:2,bytes:5*1048576}),true);
assert.equal(backgroundDataAllowed({lowMemory:false,activeBuilds:2,bytes:480*1048576}),true);
assert.equal(backgroundDataAllowed({lowMemory:true,activeBuilds:0,bytes:480*1048576}),true);
