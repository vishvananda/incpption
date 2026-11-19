import {WASI, File, OpenFile, ConsoleStdout, PreopenDirectory} from '/shim/index.js';
import {errorText} from './error_text.mjs';

function input(bytes) {
  const file = new File([]);
  file.data = bytes;
  return file;
}

self.onmessage = async ({data: {module, files, project}}) => {
  const messages = [];
  try {
    const share = new PreopenDirectory('/mnt/plan', Object.entries(files).map(([name, bytes]) => [name, input(bytes)]));
    const write = line => {
      messages.push(line);
      postMessage({kind: 'configure-log', line});
    };
    const wasi = new WASI(['guest', '-no-stdin', '-entrypoint', '/bin/sh', '--', '/mnt/plan/configure.sh'],
      [], [new OpenFile(new File([])), ConsoleStdout.lineBuffered(write), ConsoleStdout.lineBuffered(write), share],
      {debug: false});
    const start = performance.now();
    const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1: wasi.wasiImport});
    const status = wasi.start(instance);
    const contents = share.dir.contents;
    const plan = contents.get(project + '.cwl')?.data;
    const snapshot = contents.get(project + '.bin')?.data;
    const report = contents.get('results.json')?.data;
    const sdk = contents.get('sdk.json')?.data;
    const decoder = new TextDecoder();
    const results = report && JSON.parse(decoder.decode(report));
    if (status || !plan || !snapshot || !sdk || results?.[0]?.status !== 'captured')
      throw Error(results?.[0]?.error || 'Configuration exited with status ' + status);
    postMessage({kind: 'configured', plan, snapshot, sdk: JSON.parse(decoder.decode(sdk)), configSeconds: (performance.now() - start) / 1000,
      captureSeconds: results[0].seconds}, [plan.buffer, snapshot.buffer]);
  } catch (error) {
    postMessage({kind: 'error', error: [errorText(error), ...messages.slice(-25)].join('\n')});
  }
};
