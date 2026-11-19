import {useInputPort} from './transport_bytes.mjs';
import {mountLayers,insert,fileView} from './wasi_runtime.mjs';
import {loadSeed} from './seed_package.mjs';
import {finishProject} from './project_link.mjs';
import {errorText} from './error_text.mjs';
self.onmessage=async({data})=>{
  const started=performance.now();useInputPort(data.inputPort);
  try{
    postMessage({kind:'loading',message:'Loading the linker'});
    const lld=data.clang?await loadSeed('lld'):null;
    const module=lld?null:await WebAssembly.compile(data.compilerBytes);
    const root=mountLayers(data.layers);
    for(const file of data.files)insert(root,file.path,fileView(file.bytes));
    const compileStarted=performance.now();postMessage({kind:'link-ready'});
    await finishProject({...data,root,module,lld,started,compileStarted,deferredLinker:true});
  }catch(error){postMessage({kind:'error',error:errorText(error)});}
};
