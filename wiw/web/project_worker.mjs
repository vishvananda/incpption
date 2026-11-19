import {useInputPort} from './transport_bytes.mjs';
import {Directory,hash,equal,insert,lookup,loadCompiler,fileView} from './wasi_runtime.mjs';
import {CompilePool} from './compile_pool.mjs';
import {loadGamePackage} from './game_package.mjs';
import {loadSeed} from './seed_package.mjs';
import {clangCompileArgs} from './clang_arguments.mjs';
import {finishProject} from './project_link.mjs';
let release;
self.onmessage=async({data})=>{
  if(data.kind==='start'){release?.();return;}
  useInputPort(data.inputPort);
  const started=performance.now(),pool=new CompilePool(data.ports, data);
  try{
    postMessage({kind:'loading',message:'Checking compiler, project and supporting source'});
    const compiler=await loadCompiler((data.sharedAssets ?? '') + 'compiler/',{shareInputs:true,inputProfile:'none',compileModule:data.compiler!=='clang',loadSeedBytes:data.compiler!=='clang'});
    const {root,layers,seedBytes,expectedManifest}=compiler;
    let module=compiler.module;
    if(data.compilerBytes){equal(seedBytes,data.compilerBytes,'rebuilt compiler');module=await WebAssembly.compile(data.compilerBytes);}
    const {manifest,expected}=await loadGamePackage(compiler,{shared:true,prefix:data.package||'projects/lara/'});
    if(manifest.schema!==2)throw Error('A complete project package is required');
    root.contents.set('build',new Directory([]));
    const childSeed=data.compiler==='clang'&&data.lowMemory&&data.workerCount===1;
    const clang=data.compiler==='clang'?(childSeed?{seed:'clang'}:await loadSeed('clang')):null,lld=clang&&!data.lowMemory?await loadSeed('lld'):null;
    const units=[...manifest.commands,...manifest.archives,manifest.link];
    postMessage({kind:'ready',sources:units.map(row=>row.name),unitSources:units.map(row=>row.source||null),
      categories:units.map(row=>row.category||'link'),workerCount:data.workerCount,revision:compiler.manifest.revision});
    await pool.initialize(clang?.module||module,layers,clang?{runtime:clang.runtime,seed:clang.seed,program:'clang++'}:null);
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
    const packageURL=new URL(data.package||'projects/lara/',self.location.href).href;
    if(data.lowMemory){
      const files=manifest.commands.map(row=>({path:row.output,bytes:lookup(root,row.output).data}));
      const compilerBytes=clang?null:data.compilerBytes||seedBytes;
      postMessage({kind:'link-stage',manifest,expected,expectedManifest,layers,files,compilerBytes,clang:!!clang,
        initialSeconds:(performance.now()-started)/1000,initialCompileSeconds:(performance.now()-compileStarted)/1000,
        workerCount:data.workerCount,peak,packageURL},[...files.map(file=>file.bytes.buffer),...(compilerBytes?[compilerBytes.buffer]:[])]);
      return;
    }
    await finishProject({root,layers,module,lld,manifest,expected,expectedManifest,started,compileStarted,
      workerCount:data.workerCount,peak,packageURL});
  }catch(error){postMessage({kind:'error',error:String(error),stack:error.stack,seconds:(performance.now()-started)/1000});}
  finally{pool.close();}
};
