import {mountLayers, insert, lookup, fileView, invoke} from './wasi_runtime.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
let root, module, layers, host;
self.onmessage = ({data: {port}}) => {
  port.onmessage = async ({data}) => {
    try {
      if (data.kind === 'init') {
        layers = data.layers; host = data.host;
        root = host ? null : mountLayers(layers);
        module = data.module;
        port.postMessage({kind: 'ready'});
        return;
      }
      if (data.kind !== 'compile' || (!root && !host) || !module) throw Error('Compiler worker is not initialized');
      const start = performance.now();
      if (host) {
        let result;
        if(data.language==='assembler-with-cpp'||data.language==='assembler'){
          let source=data.args.find(value=>value.endsWith('.S')||value.endsWith('.s')),files=[];
          if(data.language==='assembler-with-cpp'){
            const preprocessed=data.output+'.s',args=data.args.filter(value=>value!=='-c');args[args.indexOf('-o')+1]=preprocessed;args.push('-E','-fintegrated-cc1');
            const prepared=await invokeEmscripten({module,layers,...host,args,output:preprocessed});
            source=preprocessed;files=[{path:source,bytes:prepared.bytes}];
          }
          result=await invokeEmscripten({module,layers,...host,files,args:['-cc1as','-triple','wasm32-unknown-emscripten','-target-feature','+bulk-memory','-filetype','obj','-o',data.output,source],output:data.output});
        }else result=await invokeEmscripten({module,layers,...host,args:data.args,output:data.output});
        port.postMessage({kind: 'result', index: data.index, seconds: (performance.now()-start)/1000, ...result}, [result.bytes.buffer]);
        return;
      }
      insert(root, data.output, fileView(new Uint8Array(), false));
      const result = await invoke(module, root, data.args, data.sourceDateEpoch);
      if (result.status !== 0) throw Error(`${data.output}: exit ${result.status}\n${result.log.join('\n')}`);
      const output=lookup(root,data.output);
      const bytes=output?.take?output.take():output?.data;
      if (!bytes) throw Error(`missing output: ${data.output}`);
      const parts = data.output.split('/');
      lookup(root, parts.slice(0, -1).join('/')).contents.delete(parts.at(-1));
      port.postMessage({kind: 'result', index: data.index, bytes,
        seconds: (performance.now() - start) / 1000, ...result}, [bytes.buffer]);
    } catch (error) {port.postMessage({kind: 'error', error: `${data.output || 'worker'}: ${error.stack || error}`});}
  };
};
