import {attachGameControls} from './game_controls.mjs';
import {runtimeExports} from './game_exports.mjs';
// Start the actual browser-built module with its frozen runtime and assets.
export async function playOpenLara(canvas, build, log = console.log) {
  const audioContext = new AudioContext();
  await audioContext.resume();
  const runtimeHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', build.runtime)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const runtimeURL = new URL(`game/runtime.${runtimeHash}.mjs`, import.meta.url).href;
  const {default: OpenLara} = await import(runtimeURL);
  let draws = 0, processor;
  // The runtime promise resolves before the asynchronous settings/title load.
  // Wait for its first rendered frame before selecting the playable level.
  let initialFrame;
  const firstFrame = new Promise(resolve => {initialFrame = resolve;});
  const print = text => {log(text); if (String(text).startsWith('FPS:')) initialFrame();};
  window.getLanguage = () => window.Module.ccall('set_def_lang', null, ['number'], [0]);
  window.snd_init = () => {
    const module = window.Module, count = 4096;
    const framesCount = Math.ceil(count * 44100 / audioContext.sampleRate);
    const frames = module._malloc(framesCount * 4);
    processor = audioContext.createScriptProcessor(count, 0, 2);
    processor.onaudioprocess = event => {
      module.ccall('snd_fill', null, ['number', 'number'], [frames, framesCount]);
      const samples = new Int16Array(module.getMemory().buffer);
      const left = event.outputBuffer.getChannelData(0), right = event.outputBuffer.getChannelData(1);
      for (let i = 0; i < count; i++) {
        const j = (frames >> 1) + Math.floor(i * 44100 / audioContext.sampleRate) * 2;
        left[i] = samples[j] / 32768;
        right[i] = samples[j + 1] / 32768;
      }
    };
    processor.connect(audioContext.destination);
  };
  let wasmReject;
  const wasmFailed = new Promise((_,reject) => {wasmReject=reject;});
  const module = await Promise.race([wasmFailed, OpenLara({wasmBinary: build.game, canvas, print, printErr: log,
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(build.game, imports).then(({instance, module}) => {
        receive({exports: runtimeExports(instance.exports)}, module);
      }).catch(wasmReject);
      return {};
    }, preRun: [m => {
    window.Module = m;
    m.FS.mkdirTree('/level/1');
    m.FS.mkdirTree('/audio/1');
    for (const asset of build.assets) m.FS.writeFile('/' + asset.name, asset.bytes);
    const create = m.GL.createContext;
    m.GL.createContext = function(...args) {
      const handle = create.apply(this, args), gl = m.GL.contexts[handle]?.GLctx;
      if (gl) for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        const method = gl[name];
        gl[name] = function(...values) { draws++; return method.apply(this, values); };
      }
      return handle;
    };
  }]})]);
  let timeout;
  try {
    await Promise.race([firstFrame, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('The game did not finish initialization.')), 60000);
    })]);
  } finally {clearTimeout(timeout);}
  const level = build.assets.find(asset => asset.name === 'level/1/LEVEL1.PSX');
  const pointer = module._malloc(level.bytes.length);
  new Uint8Array(module.getMemory().buffer).set(level.bytes, pointer);
  module.ccall('game_level_load', null, ['number', 'number'], [pointer, level.bytes.length]);
  draws = 0;
  const controls = attachGameControls(canvas);
  canvas.focus();
  return {module, audioContext, processor, controls, get drawCalls() { return draws; }};
}
