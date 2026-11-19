import {WASI, File, OpenFile} from '/shim/index.js';

self.onmessage = async ({data:{module, text}}) => {
  try {
    const stdout = new File([]), stderr = new File([]);
    const wasi = new WASI(['qrencode','-t','SVG','-o','-',text], [],
      [new OpenFile(new File([])), new OpenFile(stdout), new OpenFile(stderr)], {debug:false});
    const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1:wasi.wasiImport});
    const status = wasi.start(instance);
    const output = stdout.data;
    if (status !== 0 || !output.length || output.length > 2 * 1024 * 1024)
      throw Error(new TextDecoder().decode(stderr.data) || 'The QR generator did not return an image.');
    postMessage({output}, [output.buffer]);
  } catch (error) {postMessage({error:error.message});}
};
