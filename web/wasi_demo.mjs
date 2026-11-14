import {demoCopy} from './demo_copy.mjs';
import {BuildSession} from './build_session.mjs';
const $ = id => document.getElementById(id);
const copy = demoCopy;
$('intro').textContent = copy.site.intro;
$('story').textContent = copy.site.story;
document.querySelector('.locality').textContent = copy.site.locality;
const start = $('start'), cancel = $('cancel'), units = $('units');
let worker, timer, deadline, started, names = [], currentStage = 2, selected = -1;
let running = {}, rows = {2: new Map(), 3: new Map()}, buttons = [], urls = [];
let verified = 0, peak = 0, stopped = true;
let rebuiltCompiler, gameWorker, gameArtifact, gameDeadline;
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function state(stage, status, label) {
  $(stage).className = `stage ${status}`;
  $(`${stage}-state`).textContent = label;
}
function inspect(index) {
  selected = index;
  for (const [i, button] of buttons.entries()) button.classList.toggle('selected', i === index);
  const row = rows[currentStage].get(index);
  $('unit-detail').textContent = row ? `${names[index]}\n${row.seconds.toFixed(3)} s · ${row.bytes.toLocaleString()} bytes · ${Math.ceil(row.memoryBytes / 1048576)} MiB guest memory\nSHA-256 ${row.sha256}`
    : `${names[index] ?? 'Select a source file'}\n${running[currentStage]?.has(index) ? 'Running in the browser…' : 'Waiting for this generation.'}`;
}
function draw() {
  for (const [index, button] of buttons.entries()) {
    button.className = `unit${rows[currentStage].has(index) ? ' done' : running[currentStage]?.has(index) ? ' active' : ''}${index === selected ? ' selected' : ''}`;
    button.setAttribute('aria-label', `${names[index]}: ${rows[currentStage].has(index) ? 'verified' : running[currentStage]?.has(index) ? 'running' : 'waiting'}`);
  }
  $('completed').textContent = `${rows[currentStage].size} / ${names.length}`;
  for (const stage of [2, 3]) $(`view-${stage}`).setAttribute('aria-pressed', String(stage === currentStage));
  if (selected >= 0) inspect(selected);
}
function view(stage) {currentStage = stage; draw();}
$('view-2').onclick = () => view(2);
$('view-3').onclick = () => view(3);
function stop() {
  worker?.terminate(); worker = null; clearInterval(timer); clearTimeout(deadline);
  start.disabled = false; cancel.disabled = true; stopped = true; $('worker-choice').disabled = false; $('deep-verify').disabled = false;
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], {type})); urls.push(url);
  const link = document.createElement('a'); link.href = url; link.download = name; link.textContent = name;
  $('downloads').append(link);
}
function fail(message) {
  stop(); $('status').textContent = 'Build stopped. No compiler artifact was published.';
  $('log').textContent += `${message}\n`;
  for (const index of running[currentStage] || []) buttons[index]?.classList.add('failed');
  window.lastInceptionEvent = {kind: 'error', error: message};
}
start.onclick = () => {
  rebuiltCompiler = null; gameArtifact = null; gameWorker?.terminate(); clearTimeout(gameDeadline);
  $('game-build').disabled = true; $('game-play').disabled = true; $('game-cancel').disabled = true;
  $('game-status').textContent = copy.stages.game.waiting;
  $('game-downloads').replaceChildren(); $('game-log').textContent = '';
  for (let i = 0; i < 4; i++) $(`game-unit-${i}`).className = '';
  for (const url of urls) URL.revokeObjectURL(url);
  urls = []; $('downloads').replaceChildren(); $('compiler-hash').textContent = ''; $('log').textContent = '';
  names = []; buttons = []; units.replaceChildren(); rows = {2: new Map(), 3: new Map()}; running = {};
  verified = 0; peak = 0; selected = -1; currentStage = 2; started = performance.now(); stopped = false;
  $('completed').textContent = '—'; $('verified').textContent = '0'; $('memory').textContent = '—'; $('elapsed').textContent = '0:00';
  $('progress').value = 0; $('progress').max = 1; start.disabled = true; cancel.disabled = false;
  for (const stage of [2, 3]) {state(`stage-${stage}`, '', 'Waiting'); $(`stage-${stage}-detail`).textContent = stage === 2 ? 'The self-built Wasm compiler rebuilds itself here. Every output must match.' : 'The rebuilt compiler repeats the build. Every output must match again.';}
  state('final-check', '', 'Waiting'); state('seed', 'active', 'Verifying');
  $('seed-detail').textContent = 'Verify the compiler and its source package.';
  $('status').textContent = 'Verifying source files, runtime and compiler…';
  $('worker-choice').disabled = true; $('deep-verify').disabled = true;
  window.lastInceptionEvent = {kind: 'starting'};
  worker = new BuildSession('./wasi_worker.mjs', {workers: Number($('worker-choice').value)});
  timer = setInterval(() => {$('elapsed').textContent = clock((performance.now() - started) / 1000);}, 500);
  deadline = setTimeout(() => fail('The 60-minute build deadline was exceeded.'), 3600000);
  worker.onmessage = ({data}) => {
    window.lastInceptionEvent = data.kind === 'complete' ? {...data, module: undefined} : data;
    if (data.kind === 'ready') {
      names = [...data.sources, 'link compiler'];
      for (const [index, name] of names.entries()) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'unit';
        button.title = name; button.onclick = () => inspect(index); units.append(button); buttons.push(button);
      }
      state('seed', 'done', 'Verified');
      $('seed-detail').textContent = `${(data.seedBytes / 1048576).toFixed(1)} MiB compiler · ${data.sources.length} sources`;
      $('revision').textContent = `Base ${data.revision.slice(0, 9)}${data.dirty ? ' + experimental changes' : ''} · frozen source ${(data.sourceSha256 || data.manifest).slice(0, 12)}`;
      $('compiler-hash').textContent = `Seed SHA-256 ${data.seedSha256}`;
      $('progress').max = names.length * data.generations; $('worker-count').textContent = `${data.workerCount} compile worker${data.workerCount === 1 ? '' : 's'} · linking follows compilation`; draw();
    }
    if (data.kind === 'progress') {
      (running[data.stage] ??= new Set()).add(data.index); view(data.stage); state(`stage-${data.stage}`, 'active', 'Building');
      $('status').textContent = `${data.stage === 2 ? 'Rebuilding cppgm locally in your browser' : 'Second local rebuild'}: ${data.name}`;
    }
    if (data.kind === 'unit') {
      rows[data.stage].set(data.index, data); running[data.stage]?.delete(data.index); verified++;
      peak = Math.max(peak, data.memoryBytes); $('memory').textContent = `${Math.ceil(peak / 1048576)} MiB`;
      $('verified').textContent = String(verified); $('progress').value = verified; draw();
    }
    if (data.kind === 'stage') {
      state(`stage-${data.stage}`, 'done', 'Byte-identical');
      $(`stage-${data.stage}-detail`).textContent = `${names.length} outputs verified · ${clock(data.seconds)}`;
      $('log').textContent += `W${data.stage}: every object and final module match. ${data.seconds.toFixed(1)} s.\n`;
    }
    if (data.kind === 'checking') {
      state('final-check', 'active', 'Checking'); $('status').textContent = `Checking ${data.name}…`;
    }
    if (data.kind === 'error') fail(data.error);
    if (data.kind === 'complete') {
      stop(); state('final-check', 'done', 'Passed'); $('elapsed').textContent = clock(data.seconds);
      $('status').textContent = copy.states.completeMessage;
      $('final-detail').textContent = 'Rebuilt compiler runs; accepted, rejected and x86 output checks passed.';
      $('compiler-hash').textContent = `Final SHA-256 ${data.stages.at(-1).commands.at(-1).sha256}`;
      rebuiltCompiler = data.module;
      download('cppgm-rebuilt.wasm', data.module, 'application/wasm'); delete data.module;
      download('inception-results.json', JSON.stringify(data, null, 2) + '\n', 'application/json');
      $('game-build').disabled = false; $('game-status').textContent = copy.stages.game.ready;
    }
  };
  worker.onerror = event => fail(event.message);
  worker.postMessage({secondBuild: $('deep-verify').checked});
};
cancel.onclick = () => {
  if (stopped) return;
  stop(); $('status').textContent = 'Cancelled. Start a fresh build to retry.';
  window.lastInceptionEvent = {kind: 'cancelled'};
};

function gameLog(text) {$('game-log').textContent += String(text) + '\n';}
function gameStop() {
  gameWorker?.terminate(); gameWorker = null; clearTimeout(gameDeadline);
  $('game-build').disabled = !rebuiltCompiler; $('game-cancel').disabled = true;
  start.disabled = false;
}
function gameFail(message) {
  gameStop(); $('game-status').textContent = copy.stages.game.error; gameLog(message);
  window.lastGameBuild = {kind: 'error', error: message};
}
function gameDownload(name, bytes, type) {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([bytes], {type}));
  urls.push(url); link.href = url; link.download = name; link.textContent = name; $('game-downloads').append(link);
}
$('game-build').onclick = () => {
  if (!rebuiltCompiler) return;
  gameArtifact = null; $('game-play').disabled = true; $('game-build').disabled = true;
  $('game-cancel').disabled = false; start.disabled = true;
  $('game-downloads').replaceChildren(); $('game-log').textContent = '';
  for (let i = 0; i < 4; i++) $(`game-unit-${i}`).className = '';
  window.lastGameBuild = {kind: 'starting'};
  gameWorker = new BuildSession('./openlara_worker.mjs', {maximum: 3});
  gameWorker.onmessage = ({data}) => {
    window.lastGameBuild = {...data, game: undefined, runtime: undefined, assets: undefined};
    if (data.kind === 'loading') $('game-status').textContent = data.message;
    if (data.kind === 'progress') $('game-status').textContent = `${data.index === 3 ? 'Linking' : 'Compiling'} locally in your browser: ${data.name}`;
    if (data.kind === 'unit') {
      $(`game-unit-${data.index}`).className = 'done';
      gameLog(`${data.name}: matched · ${data.seconds.toFixed(3)} s · SHA-256 ${data.sha256}`);
    }
    if (data.kind === 'error') gameFail(data.error);
    if (data.kind === 'complete') {
      gameStop(); gameArtifact = data; $('game-play').disabled = false;
      $('game-status').textContent = `${copy.stages.game.complete} ${data.seconds.toFixed(1)} seconds; every output matched.`;
      gameDownload('openlara.wasm', data.game, 'application/wasm');
      gameDownload('game-results.json', JSON.stringify({...data, game: undefined, runtime: undefined, assets: undefined}, null, 2), 'application/json');
    }
  };
  gameWorker.onerror = event => gameFail(event.message);
  gameDeadline = setTimeout(() => gameFail('The game build exceeded its 10-minute deadline.'), 600000);
  const bytes = rebuiltCompiler.slice();
  gameWorker.postMessage({compilerBytes: bytes}, [bytes.buffer]);
};
$('game-cancel').onclick = () => {
  gameStop(); $('game-status').textContent = copy.stages.game.cancelled;
  window.lastGameBuild = {kind: 'cancelled'};
};
$('game-play').onclick = async () => {
  if (!gameArtifact) return;
  $('game-play').disabled = true; $('game-build').disabled = true; start.disabled = true;
  $('game-screen').hidden = false; $('game-status').textContent = 'Opening the game you just built…';
  try {
    const {playOpenLara} = await import('./openlara_play.mjs');
    window.openLaraGame = await playOpenLara($('canvas'), gameArtifact, gameLog);
    $('game-status').textContent = copy.stages.play.running; window.gamePlaying = true;
    $('canvas').scrollIntoView({behavior: 'smooth', block: 'center'});
  } catch (error) {gameLog(error.stack || error); window.gameError = String(error); $('game-status').textContent = 'The game could not start. See game build details.';}
};

$('deep-verify').onchange = () => {
  const deep = $('deep-verify').checked; $('stage-3').hidden = !deep; $('view-3').hidden = !deep;
  $('how-it-works').classList.toggle('deep-mode', deep);
  $('final-check').querySelector('.number').textContent = `${deep ? '04' : '03'} / MATCH & CHECK`;
  $('game').querySelector('.eyebrow').textContent = `${deep ? '05' : '04'} / PUT IT TO WORK`;
};
