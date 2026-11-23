import {hash} from './transport_bytes.mjs';

export async function configureNano(project, input, runtime, signal, log) {
  signal.throwIfAborted();
  if (!['auto', 'configure', 'make'].includes(input.config.system))
    throw Error('This project needs the Alpine build tools.');
  const worker = new Worker(new URL('./nano-worker.mjs', import.meta.url), {type:'module'});
  let abort, timeout;
  try {
    const {workflow, snapshot} = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      timeout = setTimeout(() => reject(Error('NanoVM exceeded the time limit for generating a plan.')), 300000);
      signal.addEventListener('abort', abort, {once:true});
      worker.onerror = event => reject(Error(event.message || 'NanoVM stopped.'));
      worker.onmessageerror = () => reject(Error('Could not read a message from NanoVM.'));
      worker.onmessage = ({data}) => {
        if (data.kind === 'log') log(data.line);
        if (data.kind === 'error') reject(Object.assign(Error(data.error), {system:data.system}));
        if (data.kind === 'configured') resolve(data);
      };
      worker.postMessage({input, runtime});
    });
    return {schema:'willitwasm/v1', kind:'alpine-cwl', ...project, target:'wasm32-wasip1',
      workflow, snapshot, snapshotSha256:await hash(snapshot)};
  } finally {
    signal.removeEventListener('abort', abort);
    clearTimeout(timeout);
    worker.terminate();
  }
}
