import {hash,insert,lookup,invoke,fileView} from './wasi_runtime.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {lldArgs} from './clang_arguments.mjs';
import {archive} from './ar.mjs';
// Shared by the normal coordinator and the isolated phone linker.
export async function finishProject({root,layers,module,lld,manifest,expected,expectedManifest,started,compileStarted,
  initialSeconds=0,initialCompileSeconds=0,workerCount,peak=0,packageURL,deferredLinker=false}) {
  const clang=!!lld,total=manifest.commands.length+manifest.archives.length+1;
  let index=manifest.commands.length;
  for(const row of manifest.archives){
    const before=performance.now();postMessage({kind:'progress',index,total,name:row.name,category:'archive'});
    const bytes=archive(row.members.map(item=>({name:item.name,bytes:lookup(root,item.path).data})));
    if(!clang&&await hash(bytes)!==row.sha256)throw Error('Browser archive differs: '+row.name);
    insert(root,row.output,fileView(bytes));
    postMessage({kind:'unit',index:index++,name:row.name,category:'archive',bytes:bytes.length,seconds:(performance.now()-before)/1000});
  }
  const command=manifest.link,before=performance.now();
  postMessage({kind:'progress',index,total,name:command.name,category:'link'});
  const files=lld?[...manifest.commands,...manifest.archives].map(row=>({path:row.output,bytes:lookup(root,row.output).data})):[];
  const result=lld?await invokeEmscripten({module:lld.module,runtime:lld.runtime,program:'wasm-ld',layers,files,args:lldArgs(command.args),output:command.output}):await invoke(module,root,command.args);
  if(result.status)throw Error(result.log.join('\n')||'Project link failed');
  const output=lookup(root,command.output),game=lld?result.bytes:output?.take?output.take():output?.data;
  if(!game)throw Error('The linker produced no module');
  const sha256=await hash(game);
  if(!clang&&sha256!==command.sha256)throw Error('Browser link differs: '+manifest.id);
  peak=Math.max(peak,result.memoryBytes||0);
  postMessage({kind:'unit',index,name:command.name,category:'link',seconds:(performance.now()-before)/1000,bytes:game.length,memoryBytes:result.memoryBytes,sha256});
  postMessage({kind:'complete',project:manifest.id,manifest:expected,compilerManifest:expectedManifest,
    seconds:initialSeconds+(performance.now()-started)/1000,compileSeconds:initialCompileSeconds+(performance.now()-compileStarted)/1000,
    workerCount,memoryBytes:peak,deferredLinker,game,sha256,player:{...manifest.player,baseURL:packageURL}},[game.buffer]);
}
