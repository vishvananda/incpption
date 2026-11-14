import {mountLayers, insert, lookup, fileView, invoke} from './wasi_runtime.mjs';
let root, module;
self.onmessage = ({data: {port}}) => {
  port.onmessage = async ({data}) => {
    try {
      if (data.kind === 'init') {
        root = mountLayers(data.layers);
        module = data.module;
        port.postMessage({kind: 'ready'});
        return;
      }
      if (data.kind !== 'compile' || !root || !module) throw Error('Compiler worker is not initialized');
      const start = performance.now();
      insert(root, data.output, fileView(new Uint8Array(), false));
      const result = await invoke(module, root, data.args);
      if (result.status !== 0) throw Error(`${data.output}: exit ${result.status}\n${result.log.join('\n')}`);
      const bytes = lookup(root, data.output)?.data;
      if (!bytes) throw Error(`missing output: ${data.output}`);
      const parts = data.output.split('/');
      lookup(root, parts.slice(0, -1).join('/')).contents.delete(parts.at(-1));
      port.postMessage({kind: 'result', index: data.index, bytes,
        seconds: (performance.now() - start) / 1000, ...result}, [bytes.buffer]);
    } catch (error) {port.postMessage({kind: 'error', error: String(error)});}
  };
};
