// Qualification uses the same WASI adapter as the browser, including large writes.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [project,reference,runtime]=process.argv.slice(2).map(value=>path.resolve(value));
const {Directory,insert,fileView,invoke,lookup}=await import(pathToFileURL(path.join(runtime,'wasi_runtime.mjs')));
const manifest=JSON.parse(fs.readFileSync(path.join(project,'manifest.json'))),root=new Directory([]);
for(const row of [...manifest.commands,...manifest.archives])
  insert(root,row.output,fileView(fs.readFileSync(path.join(project,'inputs',row.output))));
const module=await WebAssembly.compile(fs.readFileSync(path.join(reference,'inputs/w1/cppgm.wasm')));
const result=await invoke(module,root,manifest.link.args,manifest.source_date_epoch);
if(result.status)throw Error(result.log.join('\n'));
const file=lookup(root,manifest.link.output),bytes=file.take?file.take():file.data;
fs.writeFileSync(path.join(project,'inputs',manifest.link.output),bytes);
console.log(JSON.stringify({bytes:bytes.length,memoryBytes:result.memoryBytes}));
