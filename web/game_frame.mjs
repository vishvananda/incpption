import {playOpenLara} from './openlara_play.mjs';
let running;
const resize = () => parent.postMessage({kind:'game-frame-size',height:document.documentElement.scrollHeight},location.origin);
window.startGame = async (build, log) => {
  if (running) throw Error('Game is already running');
  running = true;
  window.openLaraGame = await playOpenLara(document.getElementById('canvas'), build, log);
  resize();
  return window.openLaraGame;
};
window.stopGame = async () => {
  window.Module?.pauseMainLoop();
  const game = window.openLaraGame;
  if (game?.processor) game.processor.onaudioprocess = null;
  game?.controls.releaseAll();
  game?.processor?.disconnect();
  // Release the graphics context before removing its frame. Disposing a live
  // software WebGL context can otherwise block the parent's Close click.
  const gl = window.Module?.GL.currentContext?.GLctx;
  const lose = gl?.getExtension('WEBGL_lose_context');
  let released = Promise.resolve();
  if (lose && !gl.isContextLost()) {
    released = new Promise(resolve => {
      const timeout = setTimeout(resolve, 1000);
      document.getElementById('canvas').addEventListener('webglcontextlost', event => {
        event.preventDefault(); clearTimeout(timeout); resolve();
      }, {once:true});
    });
    lose.loseContext();
  }
  await Promise.allSettled([released, game?.audioContext.close()]);
};
new ResizeObserver(resize).observe(document.body);
parent.postMessage({kind:'game-frame-ready'},location.origin);
