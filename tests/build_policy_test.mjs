import assert from 'node:assert/strict';
import {buildPolicy} from '../web/build_policy.mjs';
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
const safari=Error('WebAssembly.Instance: Out of memory');safari.stack='invokeEmscripten@https://site.test/emscripten_host.mjs:26:90';
assert.match(errorText(safari),/Out of memory/);assert.match(errorText(safari),/invokeEmscripten@/);
const chrome=Error('compile failed');assert.equal(errorText(chrome),chrome.stack);
assert.equal(errorText('plain failure'),'plain failure');assert.equal(errorText(null),'null');
console.log('PASS: phone/iPad/desktop worker budgets and Safari exception messages');
