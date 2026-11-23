import {hash} from './transport_bytes.mjs';

export async function configureWanix(project, input, runtime, target, signal, log) {
  signal.throwIfAborted();
  if (!['auto', 'configure', 'make', 'cmake'].includes(input.config.system))
    throw Error('This build system needs the Alpine guest.');
  const frame = document.createElement('iframe');
  frame.src = new URL('wanix_guest.html', import.meta.url);
  frame.title = 'Wanix Linux build guest';
  frame.hidden = true;
  const {port1, port2} = new MessageChannel();
  let abort, timeout;
  try {
    const {workflow, snapshot} = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      timeout = setTimeout(() => reject(Error('Wanix exceeded the time limit for generating a plan.')), 300000);
      signal.addEventListener('abort', abort, {once:true});
      port1.onmessage = ({data}) => {
        if (data.kind === 'log') log(data.line);
        if (data.kind === 'error') reject(Error(data.error));
        if (data.kind === 'configured') resolve(data);
      };
      port1.onmessageerror = () => reject(Error('Could not read a message from Wanix.'));
      frame.onerror = () => reject(Error('Could not open the Wanix guest.'));
      frame.onload = () => frame.contentWindow.postMessage({kind:'configure', input, runtime, target}, location.origin, [port2]);
      document.body.append(frame);
    });
    return {schema:'willitwasm/v1', kind:'alpine-cwl', ...project, ...(target === 'wasm32-wasip1' ? {target} : {}),
      workflow, snapshot, snapshotSha256:await hash(snapshot)};
  } finally {
    signal.removeEventListener('abort', abort);
    clearTimeout(timeout);
    port1.close();
    frame.remove();
  }
}
