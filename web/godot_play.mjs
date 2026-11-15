import {loadPlayerInputs} from './blob_parts.mjs';
export async function playGodot(canvas,build,log,onProgress){
  const {runtimeURL}=await loadPlayerInputs(build.player,onProgress);
  const {default:Engine}=await import(runtimeURL);let nextArgs=null;
  canvas.width=1280;canvas.height=800;canvas.style.aspectRatio='1280 / 800';
  Engine.loadBytes(build.game,new URL(build.player.runtimeBase,build.player.baseURL).href);
  const engine=new Engine({canvas,canvasResizePolicy:0,unloadAfterInit:false,persistentPaths:['/userfs'],persistentDrops:true,
    onPrint:log,onPrintError:log,onExecute:args=>{nextArgs=args;},
    onExit:()=>{
      if(!nextArgs)return;const args=nextArgs;nextArgs=null;
      const replacement=canvas.cloneNode();canvas.replaceWith(replacement);canvas=replacement;
      setTimeout(()=>engine.init().then(()=>engine.start({args,canvas,persistentDrops:args.includes('--project-manager')})).catch(error=>log(String(error))),0);
    }});
  await engine.init();await engine.start({args:['--project-manager','--single-window']});canvas.focus();
  return{get module(){return engine.rtenv;},engine};
}
