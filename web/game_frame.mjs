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
window.stopGame = () => {
  window.openLaraGame?.controls.releaseAll();
  window.openLaraGame?.processor?.disconnect();
  return window.openLaraGame?.audioContext.close();
};
new ResizeObserver(resize).observe(document.body);
parent.postMessage({kind:'game-frame-ready'},location.origin);
