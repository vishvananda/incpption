import {extraProjects, qrRepo} from './presets.mjs';
import {discover, examples, boundedBytes, planBlob, planKey, rawFile, remote, repoName, sourcePaths, unpackPlan, validatePlan} from './plans.mjs';
import {ProjectTree} from './project_tree.mjs';
import {bundleLayers} from './bundle_layers.mjs';
import {fetchBytes, hash} from './transport_bytes.mjs';
import {backgroundDataAllowed, buildPolicy} from './build_policy.mjs';
import {savePlan} from './storage.mjs';
import {unpackLayer} from './alpine_replay.mjs';
import {PlayerSession} from './player_session.mjs';

const $ = id => document.getElementById(id);
const decoder = new TextDecoder();
const config = await fetch('settings.json').then(response => response.json());
const policy = buildPolicy();
const sharedAssets = config.sharedAssets ?? '';
const choices = [...extraProjects.filter(row => !row.prepared || config.preparedPlans?.[row.repo.toLowerCase()]), ...examples];
const view = {plan:null, project:null, manifest:null, snapshot:null, operation:null, build:null, selected:null};
const built = new Set(), states = new Map();
const outputs = new Set();
const lines = [];
let flush, seconds, started, player, gameData, sourceRequest;
const mb = bytes => (bytes / 1048576).toFixed(bytes >= 100 * 1048576 ? 0 : 1) + ' MiB';

function log(message) {
  lines.push(String(message).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''));
  if (lines.length > 900) lines.splice(0, lines.length - 900);
  if (!flush) flush = setTimeout(() => {
    const console = $('console');
    const bottom = console.scrollHeight - console.scrollTop - console.clientHeight < 70;
    console.textContent = lines.join('\n');
    if (bottom) console.scrollTop = console.scrollHeight;
    flush = null;
  }, 50);
}

function status(message) {$('plan-status').textContent = message;}
function tab(name) {
  const source = name === 'source';
  $('console').hidden = source;
  $('source').hidden = !source;
  $('source-name').hidden = !source;
  for (const id of ['console','source']) {
    const selected = id === name;
    $(id + '-tab').classList.toggle('current', selected);
    $(id + '-tab').setAttribute('aria-pressed', String(selected));
  }
}
function download(data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const href = URL.createObjectURL(blob);
  outputs.add(href);
  const link = document.createElement('a');
  link.href = href; link.download = name; link.textContent = 'Download ' + name;
  return link;
}
function resultLinks(files, game) {
  $('results').replaceChildren(...files.map(file => download(file.bytes, file.path.split('/').at(-1))));
  if (game) {
    const play = document.createElement('button');
    play.textContent = game.project === 'godot' ? 'Open editor preview' : 'Play';
    play.onclick = () => openPlayer(game);
    $('results').prepend(play);
  }
  const qr = view.project?.repo.toLowerCase() === qrRepo && files.find(file => file.path.endsWith('/qrencode.wasm'));
  if (qr) {
    const preview = document.createElement('button');
    preview.textContent = 'Try QR generator';
    preview.onclick = async () => (await import('./qr_preview.mjs')).qrPreview($('qr-dialog'), qr.bytes);
    $('results').prepend(preview);
  }
  $('results').hidden = false;
}

const tree = new ProjectTree($('tree'), {onSelect:readFile});
function files(rows, sources, root = '') {
  $('file-empty').hidden = Boolean(rows.length);
  $('filter').hidden = !rows.length;
  $('filter').value = '';
  tree.filter = '';
  tree.expanded.clear();
  tree.setProject({id:view.project?.repo, name:view.project?.repo, root, files:rows, buildSources:sources}, null);
}
async function readFile(file) {
  const owner = view.plan;
  const request = sourceRequest = Symbol();
  view.selected = file;
  $('source-tab').disabled = false;
  $('source-name').textContent = file.path;
  const code = $('source').firstElementChild;
  code.textContent = 'Reading file…';
  tab('source');
  try {
    if (file.size > 1024 * 1024) throw Error('This file is too large to preview.');
    let bytes;
    if (owner.kind === 'example') {
      const prefix = sharedAssets + 'projects/' + owner.project + '/';
      const [layer] = await bundleLayers(prefix, view.manifest, {select: row => row.path === file.path});
      const [row] = layer.files;
      bytes = layer.bundle.subarray(row.offset, row.offset + row.size);
    } else if (owner.kind === 'wasi' || owner.kind === 'macho') {
      const path = file.path.slice('checkout/'.length);
      bytes = Object.hasOwn(owner.generated ?? {}, path) ? new TextEncoder().encode(owner.generated[path]) :
        await boundedBytes(await remote(rawFile(owner, path)), 1024 * 1024);
    } else {
      const {bundle} = view.snapshot;
      bytes = bundle.subarray(file.offset, file.offset + file.size);
    }
    if (owner !== view.plan || sourceRequest !== request) return;
    if (bytes.includes(0)) {code.textContent = 'Binary file · ' + bytes.length.toLocaleString() + ' bytes';return;}
    const text = decoder.decode(typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes);
    if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp)$/i.test(file.path)) {
      const {highlightCode} = await import('./highlight.mjs');
      if (owner === view.plan && sourceRequest === request) highlightCode(code, text, file.path.endsWith('.c') ? 'c' : 'cpp');
    } else code.textContent = text;
  } catch (error) {
    if (owner === view.plan && sourceRequest === request) code.textContent = error.message;
  }
}

function buttonState() {
  const busy = Boolean(view.operation);
  $('build').disabled = busy;
  $('cancel').hidden = !busy;
  $('worker-label').hidden = !view.plan || busy;
  $('plan-file').disabled = !view.project || busy;
}

function progress(total, done = built.size) {
  $('progress').max = Math.max(1, total);
  $('progress').value = done;
  $('progress-count').textContent = done.toLocaleString() + ' / ' + total.toLocaleString() + ' steps';
}
function updateClock() {
  const time = Math.floor((performance.now() - started) / 1000);
  $('elapsed').textContent = Math.floor(time / 60) + ':' + String(time % 60).padStart(2, '0');
}
function begin(label, timed = false) {
  view.operation?.abort();
  const controller = view.operation = new AbortController();
  status(label);
  buttonState();
  if (timed) {
    started = performance.now();
    updateClock();
    clearInterval(seconds);
    seconds = setInterval(updateClock, 1000);
  }
  return controller;
}
function end(controller) {
  if (view.operation !== controller) return false;
  view.operation = null;
  clearInterval(seconds);
  buttonState();
  return true;
}
function reset() {
  view.operation?.abort();
  view.operation = null;
  clearInterval(seconds);
  if ($('alpine-dialog').open) $('alpine-dialog').close('cancel');
  gameData = null;
  drawGameData();
  closePlayer();
  view.build = view.project = view.plan = view.manifest = view.snapshot = view.selected = null;
  for (const url of outputs) URL.revokeObjectURL(url);
  outputs.clear();
  $('download-plan').hidden = $('target').hidden = $('results').hidden = true;
  $('source-tab').disabled = true;
  $('elapsed').textContent = '0:00';
  built.clear();
  states.clear();
  progress(0);
  lines.length = 0;
  $('console').textContent = '';
  files([], []);
  tab('console');
}
function setTarget(kind, target) {
  $('target').hidden = !kind;
  $('target').textContent = kind === 'macho' ? 'macOS arm64 · Mach-O' :
    kind === 'alpine-cwl' && !target ? 'Linux x86-64 · musl' : kind === 'wasi' || target === 'wasm32-wasip1' ? 'Wasm · WASI' : 'Wasm · Emscripten';
}

async function present(project, plan, origin, signal) {
  view.project = project;
  view.plan = plan;
  const example = plan?.kind === 'example' && examples.find(row => row.id === plan.project);
  $('project-name').textContent = choices.find(row => row.repo.toLowerCase() === project.repo.toLowerCase())?.title ?? project.repo;
  setTarget(plan?.kind, plan?.target);
  if (example) {
    const prefix = sharedAssets + 'projects/' + example.id + '/';
    const [bytes, reference] = await Promise.all([fetchBytes(prefix + 'manifest.json', {signal}),
      fetchBytes(prefix + 'manifest.sha256', {signal})]);
    if (await hash(bytes) !== decoder.decode(reference).trim()) throw Error('Example manifest checksum differs.');
    signal.throwIfAborted();
    view.manifest = JSON.parse(decoder.decode(bytes));
    if (plan.project === 'doom' && view.manifest.player?.assets?.length) {
      const descriptor = {...view.manifest.player, baseURL:new URL(prefix, location.href).href};
      const total = descriptor.assets.reduce((sum, asset) =>
        sum + asset.chunks.reduce((n, chunk) => n + (chunk.encoded_bytes || chunk.size), 0), 0);
      gameData = {descriptor, total, loaded:0, state:'waiting'};
      drawGameData();
    }
    const sources = [...new Set(view.manifest.commands.map(row => row.source))].filter(Boolean);
    files(view.manifest.files, sources);
    progress(view.manifest.commands.length + view.manifest.archives.length + 1);
    status(origin + ' · cppgm ' + config.compilerVersion + (example.id === 'godot' ? ' · Long build' : ''));
    log('Using the frozen incpption Emscripten inputs for ' + example.title + '.');
  } else if (plan?.kind === 'wasi' || plan?.kind === 'macho') {
    const sources = plan.sources.map(path => 'checkout/' + path);
    files(sourcePaths(plan).map(path => ({path:'checkout/' + path})), sources, 'checkout');
    progress(plan.sources.length + 1);
    const macho = plan.kind === 'macho';
    $('download-plan').hidden = !macho;
    status(origin + ' · ' + (macho && config.machoCompilerVersion ? 'cppgm ' + config.machoCompilerVersion + ' · ' : '') + plan.commit.slice(0, 10));
    log((macho ? 'macOS arm64' : 'WASI') + ' plan ready. Loading source from GitHub at the pinned commit.');
  } else if (plan?.kind === 'emscripten') {
    status('Loading captured sources…');
    const {emscriptenLayer} = await import('./emscripten_replay.mjs');
    const snapshot = await emscriptenLayer(plan, plan.source, {signal, shared:true});
    signal.throwIfAborted();
    view.snapshot = snapshot;
    files(snapshot.files.filter(row => row.path.startsWith('checkout/') && !row.path.endsWith('/.willitwasm-cwd')),
      plan.compilation.map(row => row.source), 'checkout');
    progress(plan.compilation.length + Object.keys(plan.archives).length + plan.post.length + 1);
    status(origin + ' · Emscripten ' + plan.sdk);
    log('The browser will compile, link and run the captured Wasm post-link steps.');
  } else if (plan?.kind === 'alpine-cwl') {
    view.snapshot = unpackLayer(plan.snapshot);
    const sources = view.snapshot.files.filter(file => /\.(c|cc|cpp|cxx|s)$/i.test(file.path)).map(file => file.path);
    files(view.snapshot.files, sources, 'tmp/incpption');
    progress(Object.keys(plan.workflow.steps).length);
    $('download-plan').hidden = false;
    status(origin + ' · ' + plan.commit.slice(0, 10));
    log('Saved Alpine workspace ready for replay.');
  } else {
    status('No build plan found · ' + project.commit.slice(0, 10));
    log('No saved plan for this commit. Build opens Alpine setup. You can also open a saved plan file.');
  }
}

async function lookup(repo, ref, explicit) {
  reset();
  $('workspace').hidden = false;
  $('project-name').textContent = repo;
  const controller = begin('Finding a build plan…');
  try {
    const result = await discover({repo, ref, explicit, registry:config.registry,
      signal:controller.signal, base:location.href});
    controller.signal.throwIfAborted();
    await present(result.project, result.plan, result.origin, controller.signal);
    controller.signal.throwIfAborted();
    return true;
  } catch (error) {
    if (!controller.signal.aborted) {
      view.plan = null;
      status('Could not load the plan');
      log(error.message);
    }
  } finally {end(controller);}
  return false;
}

function workerBuild(plan, count, signal, receive) {
  const children = new Set();
  return new Promise((resolve, reject) => {
    const startWorker = (file, data, transfers = []) => {
      const worker = new Worker(new URL(file, import.meta.url), {type:'module'});
      children.add(worker);
      worker.onerror = event => reject(Error(event.message || 'Worker stopped.'));
      worker.onmessageerror = () => reject(Error('Could not read a build worker message.'));
      worker.onmessage = ({data}) => {
        if (data.kind === 'error') {reject(Error(data.error));return;}
        if (data.kind === 'release-compilers') {
          for (const child of compilers) {child.terminate();children.delete(child);}
        } else if (data.kind === 'link-stage') {
          worker.terminate(); children.delete(worker);
          startWorker('./project_link_worker.mjs', data, [...data.files.map(file => file.bytes.buffer), data.compilerBytes.buffer]);
        } else if (data.kind === 'complete') {
          resolve({game:data, files:[{path:data.project + '.wasm', bytes:data.game}], seconds:data.seconds, sha256:data.sha256});
        } else if (data.kind === 'result') resolve({files:data.products, seconds:data.seconds});
        else receive(data);
      };
      worker.postMessage(data, transfers);
      return worker;
    };
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    const compilers = [];
    if (plan.kind === 'example') {
      const ports = [];
      for (let i = 0; i < count; i++) {
        const child = new Worker(new URL('./compile_worker.mjs', import.meta.url), {type:'module'});
        children.add(child); compilers.push(child);
        child.onerror = event => reject(Error(event.message || 'Compiler worker stopped.'));
        const {port1, port2} = new MessageChannel();
        child.postMessage({port:port2}, [port2]);
        ports.push(port1);
      }
      startWorker('./project_worker.mjs', {ports, project:plan.project, package:sharedAssets + 'projects/' + plan.project + '/', sharedAssets,
        compiler:'cppgm', lowMemory:policy.lowMemory, workerCount:count}, ports);
    } else startWorker('./portable_worker.mjs', {plan, workers:count,
      sourceLayer:plan.kind === 'emscripten' ? view.snapshot : undefined});
  }).finally(() => {for (const worker of children) worker.terminate();});
}

function buildMessage(data) {
  if (data.kind === 'ready') {
    progress(data.total ?? data.sources.length);
    status('Building with cppgm');
    return;
  }
  if (data.kind === 'loading' || data.kind === 'link-ready') {
    status(data.message || 'Linking');
    log(data.message || 'Starting linker');
    return;
  }
  if (data.kind === 'unit') {
    built.add(data.index);
    progress(Math.max(data.total || 0, $('progress').max));
  }
  if (data.kind === 'progress' && data.name) log('$ ' + data.name);
  if (['unit', 'progress'].includes(data.kind) && data.source) {
    states.set(data.source, {state:data.kind === 'unit' ? 'built' : 'running'});
    tree.setStatus(states);
  }
}

async function runBuild() {
  const plan = view.plan;
  if (!plan || view.operation) return;
  const controller = begin('Loading compiler and build inputs…', true);
  view.build = null;
  for (const url of outputs) URL.revokeObjectURL(url);
  outputs.clear();
  $('results').hidden = true;
  built.clear();
  states.clear();
  tree.setStatus(states);
  progress($('progress').max);
  tab('console');
  try {
    preloadGameData(1);
    const result = await workerBuild(plan, Number($('workers').value), controller.signal, buildMessage);
    controller.signal.throwIfAborted();
    view.build = result;
    progress($('progress').max, $('progress').max);
    status('Build complete · ' + result.seconds.toFixed(1) + ' s');
    log('Build complete. ' + result.files.map(file => file.path + ' (' + mb(file.bytes.length) + ')').join(', '));
    if (result.sha256) log('SHA-256 ' + result.sha256);
    if (plan.kind === 'emscripten') {
      const {webZip} = await import('./web_zip.mjs');
      controller.signal.throwIfAborted();
      const packageName = plan.output.replace(/\.wasm$/, '.zip');
      const play = document.createElement('button');
      play.textContent = 'Play';
      play.onclick = () => openPlayer({entry:plan.entry, files:result.files});
      $('results').replaceChildren(play, download(webZip(result.files), packageName, 'application/zip'));
      $('results').hidden = false;
    } else resultLinks(result.files, result.game);
    if (plan.kind === 'macho') {
      const instructions = document.createElement('code');
      instructions.textContent = 'chmod +x ./' + plan.output;
      $('results').append(instructions);
    }
    preloadGameData(0);
  } catch (error) {
    if (!controller.signal.aborted) {
      closePlayer();
      status('Build failed');
      log(error.message);
    }
  } finally {end(controller);}
}

async function runAlpine() {
  const project = view.project;
  const controller = begin('Loading Alpine and source archive…', true);
  tab('console');
  let ready = false;
  try {
    const {configure} = await import('./alpine_configure.mjs');
    const plan = await configure(project, controller.signal, log, $('plan-target').value);
    controller.signal.throwIfAborted();
    try {await savePlan(planKey(project), plan);log('Plan saved in this browser.');}
    catch {log('Browser storage is unavailable. Use Download plan to keep a copy.');}
    controller.signal.throwIfAborted();
    await present(project, plan, 'Generated in Alpine', controller.signal);
    ready = true;
  } catch (error) {
    if (!controller.signal.aborted) {
      status('Plan generation failed');
      log(error.message);
    }
  } finally {
    if (end(controller) && ready) await runBuild();
  }
}

function canPreload(activeBuilds) {
  return backgroundDataAllowed({lowMemory:policy.lowMemory, activeBuilds, bytes:gameData.total});
}

function drawGameData() {
  const indicator = $('game-data-download');
  indicator.hidden = !gameData;
  if (!gameData) return;
  const {loaded, total, state} = gameData;
  const label = {
    waiting:`Game data ↓ ${mb(total)} · downloads ${canPreload(1) ? 'during' : 'after'} compilation`,
    downloading:`Game data ↓ ${mb(loaded)} / ${mb(total)} · downloading in background`,
    paused:`Game data ↓ ${mb(loaded)} / ${mb(total)} · paused`,
    ready:`Game data ready · ${mb(total)} cached`,
    error:'Game data will download when you open the game.',
  };
  $('game-data-label').textContent = label[state];
  const progress = $('game-data-progress');
  progress.hidden = state === 'waiting' || state === 'error';
  progress.max = total || 1;
  progress.value = loaded;
}

function ensurePlayer() {
  return player ??= new PlayerSession($('player-surface'), {url:'game_frame.html', log});
}

function preloadGameData(activeBuilds) {
  const row = gameData;
  if (!row || !['waiting', 'paused'].includes(row.state) || !canPreload(activeBuilds) ||
      (row.descriptor.jspi && typeof WebAssembly.promising !== 'function')) return;
  const session = ensurePlayer();
  const update = data => {
    if (gameData !== row || player !== session) return;
    if (data.kind === 'preload-progress') Object.assign(row, {loaded:data.loaded, total:data.total});
    if (data.kind === 'preload-complete') Object.assign(row, {loaded:row.total, state:'ready'});
    if (data.kind === 'preload-error') row.state = 'error';
    drawGameData();
  };
  row.state = 'downloading';
  drawGameData();
  session.onpreload = update;
  session.preload(row.descriptor).catch(() => update({kind:'preload-error'}));
}

function closePlayer() {
  const session = player;
  player = null;
  session?.close();
  if (gameData?.state === 'downloading') {
    gameData.state = 'paused';
    drawGameData();
  }
}

async function openPlayer(game) {
  $('player-title').textContent = $('project-name').textContent;
  $('player-dialog').showModal();
  const message = $('player-status');
  message.hidden = true;
  if (game.entry) {
    closePlayer();
    const {playWebPackage} = await import('./web_player.mjs');
    if ($('player-dialog').open) player = playWebPackage($('player-surface'), game.entry, game.files);
    return;
  }
  preloadGameData(0);
  const session = ensurePlayer();
  message.hidden = false;
  message.textContent = 'Opening the game you just built…';
  session.onprogress = ({loaded, total}) => {
    message.textContent = `Loading game data: ${mb(loaded)} / ${mb(total)}`;
  };
  try {
    await session.start(game);
    if (player === session) message.hidden = true;
  }
  catch (error) {
    if (player === session && $('player-dialog').open) {$('player-dialog').close();log(error.message);}
  }
}

for (const option of [1,2,4,8].filter(value => value <= policy.maximum)) {
  $('workers').add(new Option(String(option), String(option), false, option === policy.defaultWorkers));
}
for (const choice of choices) {
  const option = document.createElement('option');
  option.value = 'https://github.com/' + choice.repo;
  option.label = choice.title;
  $('examples').append(option);
}

function selection(repo, params = new URLSearchParams()) {
  const choice = choices.find(row => row.repo.toLowerCase() === repo.toLowerCase());
  return {
    ref:params.get('ref') ?? choice?.ref ?? null,
    plan:params.get('plan') ?? (params.has('ref') ? null : config.preparedPlans?.[repo.toLowerCase()] ?? null),
  };
}

$('repo-form').onsubmit = async event => {
  event.preventDefault();
  if (view.operation) return;
  let repo;
  try {
    repo = repoName($('repo').value);
  } catch (error) {
    $('repo').setCustomValidity(error.message);
    $('repo').reportValidity();
    return;
  }
  const url = new URL(location.href);
  let sameRepository = false;
  try {sameRepository = repoName(url.searchParams.get('repo') ?? '').toLowerCase() === repo.toLowerCase();}
  catch {} // The current link can be empty or invalid.
  const {ref, plan} = selection(repo, sameRepository ? url.searchParams : undefined);
  if (!sameRepository) {
    url.search = new URLSearchParams({repo:'https://github.com/' + repo});
    if (ref) url.searchParams.set('ref', ref);
    if (plan) url.searchParams.set('plan', plan);
    history.pushState({}, '', url);
  }
  if (!(sameRepository && view.plan) && !await lookup(repo, ref, plan)) return;
  if (view.plan) await runBuild();
  else offerAlpine();
};
$('repo').oninput = () => $('repo').setCustomValidity('');
$('cancel').onclick = () => {
  const controller = view.operation;
  controller?.abort();
  end(controller);
  closePlayer();
  status('Stopped');
  log('Stopped.');
};
function updateGuestDownload() {
  const wasi = $('plan-target').value === 'wasm32-wasip1';
  const bytes = config.guestBytes + (wasi ? config.wasiProbeBytes + config.wasiSdkBytes : 0);
  $('guest-download').textContent = 'The first run downloads about ' + mb(bytes) + '. The browser caches the Alpine image.';
}
$('plan-target').onchange = updateGuestDownload;
function offerAlpine() {
  $('plan-target').options[0].disabled = !config.wasiProbeBytes;
  $('plan-target').value = config.wasiProbeBytes ? 'wasm32-wasip1' : 'x86_64-linux-musl';
  updateGuestDownload();
  $('alpine-dialog').returnValue = '';
  $('alpine-dialog').showModal();
}
$('alpine-dialog').onclose = () => {
  if ($('alpine-dialog').returnValue === 'generate' && view.project?.commit && !view.operation) void runAlpine();
};
$('filter').oninput = () => tree.setFilter($('filter').value);
$('console-tab').onclick = () => tab('console');
$('source-tab').onclick = () => tab('source');
$('close-qr').onclick = () => $('qr-dialog').close();
$('close-player').onclick = () => $('player-dialog').close();
$('player-dialog').onclose = closePlayer;
$('download-plan').onclick = () => {
  const plan = view.plan;
  if (plan?.snapshot) download(planBlob(plan), view.project.repo.split('/').at(-1) + '.wwplan').click();
  if (plan?.kind === 'macho') download(JSON.stringify(plan, null, 2) + '\n', plan.output + '-macos-arm64.json', 'application/json').click();
};
$('plan-file').onchange = async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file || !view.project) return;
  const project = view.project;
  const controller = begin('Opening saved plan…');
  try {
    if (file.size > 128 * 1024 * 1024) throw Error('The saved plan exceeds 128 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let plan;
    if (file.name.endsWith('.json')) {
      plan = validatePlan(JSON.parse(decoder.decode(bytes)), project);
      if (plan.kind !== 'macho') throw Error('Choose a Mach-O JSON plan or an Alpine workspace.');
    } else plan = await unpackPlan(bytes, project);
    controller.signal.throwIfAborted();
    await present({...project, commit:plan.commit}, plan, 'Plan file', controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) {status('Could not open the plan');log(error.message);}
  } finally {end(controller);}
};
function fromURL() {
  const params = new URLSearchParams(location.search);
  const value = params.get('repo');
  if (!value) {reset();buttonState();$('workspace').hidden = true;return;}
  $('repo').value = value;
  try {
    const repo = repoName(value);
    const {ref, plan} = selection(repo, params);
    void lookup(repo, ref, plan);
  }
  catch (error) {
    reset();
    buttonState();
    $('workspace').hidden = false;
    status('Invalid repository');
    log(error.message);
  }
}
window.addEventListener('popstate', fromURL);
fromURL();
