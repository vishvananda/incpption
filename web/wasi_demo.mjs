import {PlayerSession} from './player_session.mjs';
import {BuildSession} from './build_session.mjs';
import {showJourney} from './journey.mjs';
const $ = id => document.getElementById(id);
const definitions = {
  llvm: {label: 'LLVM', detail: 'cppgm builds Clang + LLD', project: 'llvm', worker: 'llvm_worker.mjs'},
  clang: {label: 'cppgm-LLVM', detail: 'Clang builds cppgm', project: 'cppgm', worker: 'clang_worker.mjs'},
  match: {label: 'cppgm', detail: 'Rebuild & match every byte', project: 'cppgm', worker: 'wasi_worker.mjs'},
  game: {label: 'Lara', detail: 'Compile & link OpenLara', project: 'game', worker: 'openlara_worker.mjs'},
};
const paths = {game: ['game'], inception: ['match', 'game'], roundtrip: ['llvm', 'clang', 'match', 'game']};
const workflows = Object.fromEntries(Object.keys(paths).map(name => [name, {phases: {}, completed: false}]));
const sourceNames = {};
let scenario, active, session, deadline, automatic = false, selected = -1, urls = [], playing = false, opening = false, gameLaunch = 0;
let player;
let visiblePhase, buttons = [], peak = 0;
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const projectEvent = (project, kind, detail = {}) => window.dispatchEvent(new CustomEvent('project-build', {detail: {project, kind, ...detail}}));
const current = () => workflows[scenario];
const phase = id => current().phases[id] ??= {state: 'waiting', seconds: 0, names: sourceNames[id] || [], rows: new Map(), running: new Set()};
function seconds(row) {return row.state === 'active' ? (performance.now()-row.started)/1000 : row.seconds;}
function totalTime() {return paths[scenario].reduce((sum,id) => sum + seconds(phase(id)), 0);}
function selectProject(id) {window.dispatchEvent(new CustomEvent('project-select', {detail: {project: definitions[id].project}}));}
function drawFlow() {
  const list = $('flow'), fragment = document.createDocumentFragment();
  const seed = document.createElement('li'); seed.className = 'endpoint seed';
  seed.innerHTML = '<span class="dot" aria-hidden="true"></span><strong>cppgm seed</strong><small>Self-compiled Wasm</small>';
  fragment.append(seed);
  for (const [index,id] of paths[scenario].entries()) {
    const row = phase(id), definition = definitions[id], node = document.createElement('li');
    node.className = 'flow-node ' + row.state;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.phase = id;
    button.disabled = Boolean(active) || (index > 0 && phase(paths[scenario][index-1]).state !== 'done');
    button.innerHTML = `<span class="node-name">${definition.label}<span class="node-check">${row.state === 'done' ? id === 'match' ? '✓ matches' : '✓' : ''}</span></span><span class="node-description">${definition.detail}</span><span class="node-stats"><span>${row.rows.size} / ${row.names.length || '…'}</span><time>${clock(seconds(row))}</time></span>`;
    button.setAttribute('aria-label', `${definition.label}: ${row.state === 'done' ? id === 'match' ? 'matches' : 'built' : row.state === 'active' ? 'building' : 'build phase'}`);
    button.onclick = () => {automatic = false; runPhase(id);}; node.append(button); fragment.append(node);
  }
  const end = document.createElement('li'); end.className = 'endpoint finish' + (current().completed ? ' done' : '');
  const play = document.createElement('button'); play.id = 'game-play'; play.type = 'button'; play.disabled = !current().completed || Boolean(active);
  play.innerHTML = '<span class="dot" aria-hidden="true">▶</span><strong>Play</strong>';
  play.onclick = openGame; end.append(play); fragment.append(end);
  list.replaceChildren(fragment);
  $('run-workflow').disabled = Boolean(active);
  $('run-workflow').textContent = current().completed ? 'Run again →' : 'Run workflow →';
  $('cancel').disabled = !active;
  $('worker-choice').disabled = Boolean(active);
  for (const button of document.querySelectorAll('[data-journey]')) button.disabled = Boolean(active);
  updateTime();
}
function updateTime() {
  $('workflow-time').textContent = clock(totalTime());
  let count = 0, total = 0;
  for (const id of paths[scenario]) {const row = phase(id); count += row.rows.size; total += row.names.length;}
  $('workflow-files').textContent = total ? `${count.toLocaleString()} / ${total.toLocaleString()} files & links` : '';
  for (const button of document.querySelectorAll('[data-phase]')) button.querySelector('time').textContent = clock(seconds(phase(button.dataset.phase)));
  if (visiblePhase) $('elapsed').textContent = clock(seconds(phase(visiblePhase)));
}
function showUnits(id) {
  visiblePhase = id; selected = -1; const row = phase(id); buttons = [];
  $('phase-name').textContent = definitions[id].label;
  $('units').classList.toggle('dense', row.names.length > 1000);
  const fragment = document.createDocumentFragment();
  for (const [index,name] of row.names.entries()) {
    const button = document.createElement('button'); button.className = 'unit'; button.type = 'button'; button.title = name;
    button.onclick = () => {
      selected = index; const result = row.rows.get(index);
      $('unit-detail').textContent = `${name}${result ? ' · ' + result.seconds.toFixed(2) + ' s' + (id === 'match' ? ' · matched' : ' · built') : row.running.has(index) ? ' · building' : ' · waiting'}`;
      if (name.includes('/')) window.dispatchEvent(new CustomEvent('project-source-select', {detail: {project: definitions[id].project, path: name}}));
      paintUnits();
    };
    buttons.push(button); fragment.append(button);
  }
  $('units').replaceChildren(fragment); $('unit-detail').textContent = 'Select a square to view its source.';
  paintUnits(); updateTime();
}
function paintUnits(index) {
  const row = phase(visiblePhase);
  const update = i => {
    const result = row.rows.get(i), button = buttons[i]; if (!button) return;
    button.className = 'unit' + (result ? visiblePhase === 'match' ? ' matched' : ' done' : row.running.has(i) ? ' active' : '') + (i === selected ? ' selected' : '');
    button.setAttribute('aria-label', `${row.names[i]}: ${result ? visiblePhase === 'match' ? 'matched' : 'built' : row.running.has(i) ? 'building' : 'waiting'}`);
  };
  if (index === undefined) buttons.forEach((_,i) => update(i)); else update(index);
  $('completed').textContent = `${row.rows.size.toLocaleString()} / ${row.names.length.toLocaleString()} files & links`;
  $('progress').max = row.names.length || 1; $('progress').value = row.rows.size;
}
function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], {type})); urls.push(url);
  const a = document.createElement('a'); a.href = url; a.download = name; a.textContent = name; $('downloads').append(a);
}
function finishSession() {session?.terminate(); session = null; clearTimeout(deadline); active = null; drawFlow();}
function fail(message, cancelled = false) {
  if (!active) return;
  const id = active, row = phase(id); row.seconds = seconds(row); row.state = cancelled ? 'cancelled' : 'failed';
  projectEvent(definitions[id].project, cancelled ? 'cancel' : 'error');
  for (const index of row.running) {buttons[index]?.classList.remove('active'); if (!cancelled) buttons[index]?.classList.add('failed');}
  row.running.clear();
  automatic = false; finishSession(); $('status').textContent = cancelled ? 'Cancelled. Select this box to try again.' : 'Build stopped. Open build details for the error.';
  $('log').textContent += message + '\n';
  window.lastWorkflowEvent = {kind: cancelled ? 'cancelled' : 'error', phase: id, error: message};
  if (id === 'game') window.lastGameBuild = window.lastWorkflowEvent;
  else window.lastInceptionEvent = window.lastWorkflowEvent;
}
function runPhase(id) {
  if (active) return;
  const index = paths[scenario].indexOf(id);
  if (index < 0 || (index && phase(paths[scenario][index-1]).state !== 'done')) return;
  closeGame(); current().completed = false;
  for (const later of paths[scenario].slice(index)) current().phases[later] = {state: 'waiting', seconds: 0, names: sourceNames[later] || [], rows: new Map(), running: new Set()};
  const row = phase(id); row.state = 'active'; row.started = performance.now(); active = id; peak = 0;
  projectEvent(definitions[id].project, 'reset'); selectProject(id); showUnits(id); drawFlow();
  $('status').textContent = `Loading ${definitions[id].label} inputs…`; $('memory').textContent = '';
  window.lastWorkflowEvent = {kind: 'starting', phase: id};
  if (id === 'match') window.lastInceptionEvent = {kind: 'starting'};
  if (id === 'game') window.lastGameBuild = {kind: 'starting'};
  session = new BuildSession('./' + definitions[id].worker, {workers: Number($('worker-choice').value), maximum: id === 'game' ? 3 : 8});
  const args = {};
  if (id === 'clang') {args.compilerBytes = phase('llvm').result.module; args.runtime = phase('llvm').result.runtime;}
  if (id === 'match' && scenario === 'roundtrip') args.compilerBytes = phase('clang').result.module;
  if (id === 'game' && scenario !== 'game') args.compilerBytes = phase('match').result.module;
  session.onmessage = ({data}) => {
    const summary = {...data, module: undefined, game: undefined, runtime: undefined, assets: undefined};
    window.lastWorkflowEvent = {...summary, phase: id};
    if (id === 'game') window.lastGameBuild = summary;
    else if (id === 'match') window.lastInceptionEvent = summary;
    if (data.kind === 'loading') $('status').textContent = data.message;
    if (data.kind === 'ready') {
      row.names = id === 'match' ? [...data.sources, 'Link cppgm'] : [...data.sources];
      showUnits(id);
      $('worker-count').textContent = `${data.workerCount} workers`;
      if (data.revision) $('revision').textContent = `cppgm ${data.revision.slice(0, 12)}`;
      if (data.seedSha256) $('log').textContent += `Published seed SHA-256 ${data.seedSha256}\n`;
      drawFlow();
    }
    if (data.kind === 'progress') {
      // OpenLara announces commands as they start rather than in a ready event.
      if (!row.names.length && id === 'game') {row.names = ['Game engine', 'Sound decoder', 'Decompressor', 'Link OpenLara']; showUnits(id); $('worker-count').textContent = `${session.count} workers`;}
      row.names[data.index] = data.name; row.running.add(data.index); paintUnits(data.index);
      projectEvent(definitions[id].project, 'progress', {name: data.name});
      $('status').textContent = data.name;
    }
    if (data.kind === 'unit') {
      row.running.delete(data.index); row.rows.set(data.index, {seconds: data.seconds, bytes: data.bytes}); paintUnits(data.index);
      peak = Math.max(peak, data.memoryBytes || 0); $('memory').textContent = peak ? `${Math.ceil(peak/1048576)} MiB peak / worker` : '';
      projectEvent(definitions[id].project, 'unit', {name: data.name, matched: id === 'match', seconds: data.seconds});
      const button = document.querySelector(`[data-phase="${id}"] .node-stats span`);
      if (button) button.textContent = `${row.rows.size} / ${row.names.length}`;
      updateTime();
    }
    if (data.kind === 'checking') $('status').textContent = `Checking ${data.name}…`;
    if (data.kind === 'error') fail(data.error);
    if (data.kind === 'complete') {
      row.seconds = seconds(row); row.state = 'done'; row.result = data;
      $('log').textContent += `${definitions[id].label}: ${row.rows.size} outputs${id === 'match' ? ', every byte matched' : ''} · ${row.seconds.toFixed(1)} s\n`;
      if (id === 'match') download('cppgm-rebuilt.wasm', data.module, 'application/wasm');
      if (id === 'game') {current().completed = true; download('openlara.wasm', data.game, 'application/wasm');}
      finishSession();
      $('status').textContent = id === 'match' ? 'Every object and the compiler match. Ready to build the game.' : id === 'game' ? 'Built here. Ready to play.' : `${definitions[id].label} built. Ready for the next phase.`;
      const next = paths[scenario][index+1];
      if (automatic && next) runPhase(next);
      else if (automatic && id === 'game') {automatic = false; openGame();}
    }
  };
  session.onerror = event => fail(event.message);
  deadline = setTimeout(() => fail('This phase exceeded the 90-minute deadline.'), 90*60000);
  session.postMessage(args);
}
$('cancel').onclick = () => fail('Build cancelled by the user.', true);
$('run-workflow').onclick = () => {
  automatic = true;
  const next = paths[scenario].find(id => phase(id).state !== 'done') || paths[scenario][0]; runPhase(next);
};
function chooseScenario(name) {
  if (active) return;
  closeGame(); scenario = name; showJourney(name);
  const id = paths[name].find(id => phase(id).state !== 'done') || paths[name].at(-1);
  showUnits(id); drawFlow(); selectProject(id);
  $('status').textContent = name === 'roundtrip' ? 'Optional long build. cppgm → Clang → cppgm → matching cppgm → game.' : 'Choose a box to build, or run the whole workflow.';
}
for (const button of document.querySelectorAll('[data-journey]')) button.onclick = () => chooseScenario(button.dataset.journey);
function closeGame() {if ($('game-modal').open) {$('game-modal').close(); stopGame();}}
function stopGame() {
  if (!playing && !opening && !player) return;
  gameLaunch++; opening = false;
  player?.close(); player = null;
  playing = false; window.gamePlaying = false; window.openLaraGame = null;
}
$('game-close').onclick = closeGame;
$('game-modal').addEventListener('close', stopGame);
$('game-modal').addEventListener('click', event => {if (event.target === $('game-modal')) {const r = $('game-modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeGame();}});
async function openGame() {
  if (!current().completed || playing || opening) return;
  const launch = ++gameLaunch; opening = true;
  $('game-modal').showModal(); $('game-status').textContent = 'Opening the game you just built…'; delete window.gameError;
  try {
    const url = window.incpptionPlayerURL || document.querySelector('meta[name=player-url]').content;
    player = new PlayerSession($('game-surface'), {url,log:text => {$('log').textContent += text + '\n';}});
    const game = await player.start(phase('game').result);
    if (launch !== gameLaunch) return;
    window.openLaraGame = game; opening = false;
    playing = true; window.gamePlaying = true; $('game-status').textContent = 'Running locally.';
  } catch (error) {
    if (launch !== gameLaunch) return;
    opening = false; $('game-status').textContent = String(error); window.gameError = String(error);
  }
}
window.addEventListener('project-index-ready', ({detail: {projects}}) => {
  for (const project of projects) {
    const names = project.buildSources;
    if (project.id === 'llvm') sourceNames.llvm = [...names, 'Link LLD', 'Link Clang'];
    if (project.id === 'cppgm') sourceNames.match = sourceNames.clang = [...names, 'Link cppgm'];
    if (project.id === 'game') sourceNames.game = [...names, 'Link OpenLara'];
  }
  for (const workflow of Object.values(workflows)) for (const [id,row] of Object.entries(workflow.phases))
    if (row.state === 'waiting') row.names = sourceNames[id] || [];
  if (!active) {showUnits(visiblePhase); drawFlow();}
});
setInterval(updateTime, 250);
chooseScenario(['#inception', '#roundtrip'].includes(location.hash) ? location.hash.slice(1) : 'game');
