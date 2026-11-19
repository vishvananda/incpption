import {attachGameControls} from './game_controls.mjs';
import {loadPlayerInputs} from './blob_parts.mjs';
import {runtimeExports} from './game_exports.mjs';
export async function playDoom(canvas,build,log,onProgress){
  if(typeof WebAssembly.promising!=='function'||typeof WebAssembly.Suspending!=='function')throw Error('This browser does not support WebAssembly JSPI, which Doom 3 requires.');
  const {runtimeURL,assets}=await loadPlayerInputs(build.player,onProgress);
  const {default:createDoom}=await import(runtimeURL);let instance,rejectWasm;
  const failed=new Promise((_,reject)=>{rejectWasm=reject;});
  const options={canvas,noInitialRun:true,print:log,printErr:log,
    preRun:[module=>module.inceptionMount(assets[0].bytes)],
    instantiateWasm(imports,receive){
      const env=imports.env;
      env.emscripten_set_main_loop=(index,fps,infinite)=>{
        const callback=WebAssembly.promising(instance.exports.__indirect_function_table.get(index));let pending=false;
        options.inceptionSetMainLoop(()=>{if(pending)return;pending=true;callback().catch(rejectWasm).finally(()=>{pending=false;});},fps,infinite);
      };
      WebAssembly.instantiate(build.game,imports).then(result=>{
        instance=result.instance;const memory=instance.exports.memory;
        if(memory.buffer.byteLength<402653184)memory.grow((402653184-memory.buffer.byteLength)/65536);
        options.inceptionRelocateAsm(instance.exports);
        receive({exports:runtimeExports(instance.exports)},result.module);
      }).catch(rejectWasm);return {};
    }};
  const module=await Promise.race([createDoom(options),failed]);window.Module=module;
  module.callMain(['+set','r_fullscreen','0','+set','r_mode','0','+set','r_shadows','0','+set','s_initsound','0','+map','game/demo_mars_city2']);
  const controls=attachGameControls(canvas,{profile:'doom'});canvas.focus();
  return{module,controls};
}
