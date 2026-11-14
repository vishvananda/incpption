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
        const result = await invokeEmscripten({module, layers, ...host, args: data.args, output: data.output});
        port.postMessage({kind: 'result', index: data.index, seconds: (performance.now()-start)/1000, ...result}, [result.bytes.buffer]);
        return;
      }
      insert(root, data.output, fileView(new Uint8Array(), false));
      const result = await invoke(module, root, data.args);
      if (result.status !== 0) throw Error(`${data.output}: exit ${result.status}\n${result.log.join('\n')}`);
      const bytes = lookup(root, data.output)?.data;
      if (!bytes) throw Error(`missing output: ${data.output}`);
      const parts = data.output.split('/');
      lookup(root, parts.slice(0, -1).join('/')).contents.delete(parts.at(-1));
      port.postMessage({kind: 'result', index: data.index, bytes,
        seconds: (performance.now() - start) / 1000, ...result}, [bytes.buffer]);
    } catch (error) {port.postMessage({kind: 'error', error: `${data.output || 'worker'}: ${error.stack || error}`});}
  };
};
