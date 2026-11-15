import {playOpenLara} from './openlara_play.mjs';
import {playDoom} from './doom_play.mjs';
import {playGodot} from './godot_play.mjs';
let draws=0;
for(const type of [globalThis.WebGLRenderingContext,globalThis.WebGL2RenderingContext])if(type)for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){const original=type.prototype[name];if(original)type.prototype[name]=function(...args){draws++;return Reflect.apply(original,this,args);};}
let game, token, origin, starting = false, timer;
const send = data => parent.postMessage({channel:'cpp-inception-game',token,...data}, origin);
const size = () => {if (origin) send({kind:'size',height:document.documentElement.scrollHeight});};
window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.channel !== 'cpp-inception-game') return;
  const data = event.data;
  if (data.kind === 'start' && !starting) {
    starting = true; token = data.token; origin = event.origin;
    try {
      const play={lara:playOpenLara,doom:playDoom,godot:playGodot}[data.build.project||'lara'];
      if(!play)throw Error('Unknown project player');
      game = await play(document.getElementById('canvas'),data.build,message=>send({kind:'log',message}),(loaded,total)=>send({kind:'progress',loaded,total}));
      for(let tries=0;draws<3&&tries<600;tries++)await new Promise(resolve=>setTimeout(resolve,100));
      if(draws<3)throw Error('The project did not render a frame');
      send({kind:'playing',count:draws}); size();
      timer = setInterval(() => send({kind:'draws',count:draws}), 500);
    } catch (error) {send({kind:'error',error:String(error)});}
    return;
  }
  if (event.origin !== origin || data.token !== token) return;
  if (data.kind === 'pause') game?.module?.pauseMainLoop?.();
  if (data.kind === 'resume') game?.module?.resumeMainLoop?.();
  if (data.kind === 'stop') {
    clearInterval(timer); window.Module?.pauseMainLoop?.();
    if (game?.processor) {game.processor.onaudioprocess = null; game.processor.disconnect();}
    game?.controls?.releaseAll(); game?.audioContext?.close().catch(() => {});
  }
  if (data.request) send({kind:'ack',request:data.request});
});
new ResizeObserver(size).observe(document.body);
parent.postMessage({channel:'cpp-inception-game',kind:'ready'}, '*');
