import {useInputPort} from './transport_bytes.mjs';
import {Directory,hash,equal,insert,lookup,invoke,loadCompiler,fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';
import {loadGamePackage} from './game_package.mjs';
import {loadSeed} from './seed_package.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {clangCompileArgs,lldArgs} from './clang_arguments.mjs';
import {archive} from './ar.mjs';
let release;
self.onmessage=async({data})=>{
  if(data.kind==='start'){release?.();return;}
  useInputPort(data.inputPort);
  const started=performance.now(),pool=new CompilePool(data.ports);
  try{
    postMessage({kind:'loading',message:'Checking compiler, project and supporting source'});
    const compiler=await loadCompiler('compiler/',{shareInputs:true,inputProfile:'none'});
    const {root,layers,seedBytes,expectedManifest}=compiler;
    let module=compiler.module;
    if(data.compilerBytes){equal(seedBytes,data.compilerBytes,'rebuilt compiler');module=await WebAssembly.compile(data.compilerBytes);}
    const {manifest,expected}=await loadGamePackage(compiler,{shared:true,prefix:data.package||'projects/lara/'});
    if(manifest.schema!==2)throw Error('A complete project package is required');
    root.contents.set('build',new Directory([]));
    const clang=data.compiler==='clang'?await loadSeed('clang'):null,lld=clang?await loadSeed('lld'):null;
    const units=[...manifest.commands,...manifest.archives,manifest.link];
    postMessage({kind:'ready',sources:units.map(row=>row.name),unitSources:units.map(row=>row.source||null),
      categories:units.map(row=>row.category||'link'),workerCount:data.workerCount,revision:compiler.manifest.revision});
    await pool.initialize(clang?.module||module,layers,clang?{runtime:clang.runtime,program:'clang++'}:null);
    if(data.barrier){const ready=new Promise(resolve=>{release=resolve;});postMessage({kind:'prepared'});await ready;release=null;}
    const compileStarted=performance.now();
    const tasks=manifest.commands.map((row,index)=>({...row,sourceDateEpoch:manifest.source_date_epoch,args:clang?clangCompileArgs(row.args,row.language,manifest.source_date_epoch,manifest.id==='godot'):row.args,
      progress:{index,total:units.length,name:row.name,source:row.source,category:row.category}}));
    let peak=0;
    await pool.run(tasks,async(result,command,index)=>{
      const sha256=await hash(result.bytes);
      if(!clang&&sha256!==command.sha256)throw Error('Browser object differs: '+command.name);
      insert(root,command.output,fileView(result.bytes));peak=Math.max(peak,result.memoryBytes||0);
      postMessage({kind:'unit',index,total:units.length,name:command.name,source:command.source,category:command.category,
        seconds:result.seconds,bytes:result.bytes.length,memoryBytes:result.memoryBytes,sha256});
    });
    postMessage({kind:'release-compilers'});pool.close();
    if(clang)clang.module=null;
    let index=tasks.length;
    for(const row of manifest.archives){
      const before=performance.now();postMessage({kind:'progress',index,total:units.length,name:row.name,category:'archive'});
      const bytes=archive(row.members.map(item=>({name:item.name,bytes:lookup(root,item.path).data})));
      if(!clang&&await hash(bytes)!==row.sha256)throw Error('Browser archive differs: '+row.name);
      insert(root,row.output,fileView(bytes));
      postMessage({kind:'unit',index:index++,name:row.name,category:'archive',bytes:bytes.length,seconds:(performance.now()-before)/1000});
    }
    const command=manifest.link,before=performance.now();
    postMessage({kind:'progress',index,total:units.length,name:command.name,category:'link'});
    const args=lld?lldArgs(command.args):command.args;
    const files=[...manifest.commands,...manifest.archives].map(row=>({path:row.output,bytes:lookup(root,row.output).data}));
    const result=lld?await invokeEmscripten({module:lld.module,runtime:lld.runtime,program:'wasm-ld',layers,files,args,output:command.output}):await invoke(module,root,args);
    if(result.status)throw Error(result.log.join('\n')||'Project link failed');
    const output=lookup(root,command.output);
    const game=lld?result.bytes:output?.take?output.take():output?.data;
    if(!game)throw Error('The linker produced no module');
    const sha256=await hash(game);
    if(!clang&&sha256!==command.sha256)throw Error('Browser link differs: '+manifest.id);
    peak=Math.max(peak,result.memoryBytes||0);
    postMessage({kind:'unit',index,name:command.name,category:'link',seconds:(performance.now()-before)/1000,bytes:game.length,memoryBytes:result.memoryBytes,sha256});
    postMessage({kind:'complete',project:manifest.id,manifest:expected,compilerManifest:expectedManifest,
      seconds:(performance.now()-started)/1000,compileSeconds:(performance.now()-compileStarted)/1000,
      workerCount:data.workerCount,memoryBytes:peak,game,sha256,player:{...manifest.player,baseURL:new URL(data.package||'projects/lara/',self.location.href).href}},[game.buffer]);
  }catch(error){postMessage({kind:'error',error:String(error),stack:error.stack,seconds:(performance.now()-started)/1000});}
  finally{pool.close();}
};
