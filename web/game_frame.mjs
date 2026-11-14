import {playOpenLara} from './openlara_play.mjs';
let game, token, origin, starting = false, timer;
const send = data => parent.postMessage({channel:'cpp-inception-game',token,...data}, origin);
const size = () => {if (origin) send({kind:'size',height:document.documentElement.scrollHeight});};
window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.channel !== 'cpp-inception-game') return;
  const data = event.data;
  if (data.kind === 'start' && !starting) {
    starting = true; token = data.token; origin = event.origin;
    try {
      game = await playOpenLara(document.getElementById('canvas'), data.build, message => send({kind:'log',message}));
      send({kind:'playing',count:game.drawCalls}); size();
      timer = setInterval(() => send({kind:'draws',count:game.drawCalls}), 500);
    } catch (error) {send({kind:'error',error:String(error)});}
    return;
  }
  if (event.origin !== origin || data.token !== token) return;
  if (data.kind === 'pause') game?.module.pauseMainLoop();
  if (data.kind === 'resume') game?.module.resumeMainLoop();
  if (data.kind === 'stop') {
    clearInterval(timer); window.Module?.pauseMainLoop();
    if (game?.processor) {game.processor.onaudioprocess = null; game.processor.disconnect();}
    game?.controls.releaseAll(); game?.audioContext.close().catch(() => {});
  }
  if (data.request) send({kind:'ack',request:data.request});
});
new ResizeObserver(size).observe(document.body);
parent.postMessage({channel:'cpp-inception-game',kind:'ready'}, '*');
