import {PlayerSession} from './player_session.mjs';
import {BuildSession} from './build_session.mjs';
import {InputBroker} from './input_broker.mjs';
import {showJourney} from './journey.mjs';
import {WorkflowState, paths, isGame} from './workflow_state.mjs';
const $ = id => document.getElementById(id);
const definitions = {
  llvm: {label:'LLVM', detail:'cppgm builds clang + LLD', project:'llvm', worker:'llvm_worker.mjs'},
  clang: {label:'cppgm-LLVM', detail:'clang builds cppgm', project:'cppgm', worker:'clang_worker.mjs'},
  match: {label:'cppgm', detail:'Rebuild & match every byte', project:'cppgm', worker:'wasi_worker.mjs'},
  game: {label:'Lara', detail:'Compile & link OpenLara', project:'game', worker:'openlara_worker.mjs'},
  'game-clang': {label:'Lara', detail:'Compile & link OpenLara', project:'game', worker:'openlara_worker.mjs'},
};
const state = new WorkflowState(), jobs = new Map(), sourceNames = {}, grids = new Map(), downloads = new Map();
let scenario, target = 'lara', visiblePhase, automatic = false, player, playing = false, opening = false, gameLaunch = 0;
let selectedGame = 'game', plan, comparisonInputs;
const clock = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
const size = bytes => `${(bytes/1048576).toFixed(1)} MiB`;
const busy = () => jobs.size > 0;
const phase = id => state.phase(scenario, target, id, isGame(id) && target !== 'lara' ? [] : sourceNames[id] || []);
const seconds = row => row.state === 'active' ? (performance.now()-row.started)/1000 : row.seconds;
const buildTime = row => row.result?.compileSeconds ?? (row.compileStarted ? row.state === 'active' ? (performance.now()-row.compileStarted)/1000 : row.compileSeconds : seconds(row));
const completed = () => state.completed(scenario, target);
const projectEvent = (id, kind, detail = {}) => window.dispatchEvent(new CustomEvent('project-build', {detail:{project:definitions[id].project, kind, ...detail}}));
function selectProject(id) {
  const project=isGame(id)&&plan&&!plan.targets[target]?.available?'cppgm':definitions[id].project;
  window.dispatchEvent(new CustomEvent('project-select', {detail:{project}}));
}
function canRun(id) {
  if (isGame(id) && !plan?.targets[target]?.available) return false;
  if (scenario === 'game') return true;
  const index = paths[scenario].indexOf(id);
  return index === 0 || phase(paths[scenario][index-1]).state === 'done';
}
function downloadFiles(ids) {return new Set(ids.flatMap(id => plan?.stages[id] || []));}
function downloadSize(ids) {return [...downloadFiles(ids)].reduce((total,name) => total + (plan?.files[name] || 0), 0);}
function updateBadges() {
  for (const badge of document.querySelectorAll('[data-flow-size]')) {
    const bytes = downloadSize(paths[badge.dataset.flowSize]);
    badge.textContent = plan && !plan.targets[target]?.available ? badge.dataset.flowSize === 'game' ? 'Package pending' : '≥ '+size(bytes)+' + project' : bytes ? size(bytes) : '';
    badge.title = 'Cold download, shared files counted once. Cached files may need no transfer.';
  }
}
function addFlow(list, ids, compiler) {
  const fragment = document.createDocumentFragment(), seed = document.createElement('li');
  seed.className = 'endpoint seed';
  seed.innerHTML = `<span class="dot" aria-hidden="true"></span><strong>${compiler} seed</strong><small>${compiler === 'cppgm' ? 'Self-compiled Wasm' : 'Wasm · LLVM 22'}</small>`;
  fragment.append(seed);
  for (const id of ids) {
    const row = phase(id), definition = definitions[id], node = document.createElement('li');
    node.className = `flow-node ${row.state}${visiblePhase === id ? ' selected' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.phase = id;
    button.disabled = row.state !== 'done' && !canRun(id) || busy() && row.state === 'waiting';
    button.innerHTML = `<span class="node-name">${definition.label}<span class="node-check">${row.state === 'done' ? id === 'match' ? '✓ matches' : '✓' : ''}</span></span><span class="node-description">${definition.detail}</span><span class="node-stats"><span>${row.rows.size} / ${row.names.length || '…'}</span><time>${clock(scenario === 'game' ? buildTime(row) : seconds(row))}</time></span><span class="node-download">↓ ${isGame(id) && plan && !plan.targets[target]?.available ? 'Package pending' : size(downloadSize([id]))}</span>`;
    button.setAttribute('aria-label', `${definition.label}: ${row.state === 'done' ? id === 'match' ? 'matches, view results' : 'built, view results' : row.state === 'active' ? 'building, view progress' : 'build phase'}`);
    button.onclick = () => {
      if (row.state === 'done' || row.state === 'active') {showPhase(id); return;}
      automatic = false; start(id);
    };
    node.append(button); fragment.append(node);
  }
  const end = document.createElement('li'), gameId = compiler === 'clang' ? 'game-clang' : 'game';
  end.className = 'endpoint finish' + (phase(gameId).state === 'done' ? ' done' : '');
  const play = document.createElement('button'); play.id = compiler === 'clang' ? 'game-play-clang' : 'game-play'; play.type = 'button';
  play.disabled = phase(gameId).state !== 'done' || busy();
  play.innerHTML = `<span class="dot" aria-hidden="true">▶</span><strong>${plan?.targets[target]?.kind === 'editor' ? 'Open' : 'Play'}</strong>`;
  play.onclick = () => openGame(gameId); end.append(play); fragment.append(end);
  list.replaceChildren(fragment);
}
function drawFlow() {
  const comparison = scenario === 'game';
  $('flow-rows').classList.toggle('comparison', comparison);
  $('flow-clang').hidden = !comparison; $('clang-results').hidden = !comparison;
  addFlow($('flow'), comparison ? ['game'] : paths[scenario], 'cppgm');
  if (comparison) addFlow($('flow-clang'), ['game-clang'], 'clang');
  $('run-workflow').disabled = busy() || !plan?.targets[target]?.available;
  $('run-workflow').textContent = completed() ? 'View results' : comparison ? 'Start comparison →' : 'Run workflow →';
  $('cancel').disabled = !busy(); $('worker-choice').disabled = busy(); $('build-target').disabled = busy();
  $('rerun-phase').disabled = busy() || !visiblePhase || phase(visiblePhase).state === 'waiting' || !canRun(visiblePhase);
  $('rerun-phase').title = comparison ? 'Rerun both compilers' : 'Rerun this stage and clear later results';
  $('comparison-note').textContent = comparison ? 'Same source & SDK · O3 · equal workers · build times exclude loading' : '';
  for (const button of document.querySelectorAll('[data-journey]')) button.disabled = busy();
  updateTime(); updateBadges();
}
function updateTime() {
  $('workflow-time').textContent = clock(state.totalSeconds(scenario, target, seconds));
  const rows = paths[scenario].map(phase), count = rows.reduce((n,row) => n+row.rows.size,0), total = rows.reduce((n,row) => n+row.names.length,0);
  $('workflow-files').textContent = total ? `${count.toLocaleString()} / ${total.toLocaleString()} files & links` : '';
  for (const button of document.querySelectorAll('[data-phase]')) {
    const id = button.dataset.phase, row = phase(id);
    button.querySelector('time').textContent = clock(scenario === 'game' ? buildTime(row) : seconds(row));
    button.querySelector('.node-stats span').textContent = `${row.rows.size} / ${row.names.length || '…'}`;
  }
  if (visiblePhase) $('elapsed').textContent = clock(scenario === 'game' ? buildTime(phase('game')) : seconds(phase(visiblePhase)));
  if (scenario === 'game') $('elapsed-clang').textContent = clock(buildTime(phase('game-clang')));
}
function makeGrid(id, element) {
  const row = phase(id), buttons = [], fragment = document.createDocumentFragment();
  element.classList.toggle('dense', row.names.length > 1000);
  for (const [index,name] of row.names.entries()) {
    const button = document.createElement('button'); button.className = 'unit'; button.type = 'button'; button.title = name;
    button.onclick = () => {
      const result = row.rows.get(index), grid = grids.get(id); grid.selected = index;
      $('unit-detail').textContent = `${scenario === 'game' ? id === 'game-clang' ? 'clang · ' : 'cppgm · ' : ''}${name}${result ? ' · '+result.seconds.toFixed(2)+' s'+(id === 'match' ? ' · matched' : ' · built') : row.running.has(index) ? ' · building' : ' · waiting'}`;
      if (name.includes('/')) window.dispatchEvent(new CustomEvent('project-source-select', {detail:{project:definitions[id].project, path:name}}));
      paintGrid(id);
    };
    buttons.push(button); fragment.append(button);
  }
  element.replaceChildren(fragment); grids.set(id,{buttons, selected:-1}); paintGrid(id);
}
function paintGrid(id, index) {
  const row = phase(id), grid = grids.get(id); if (!grid) return;
  const update = i => {
    const result = row.rows.get(i), button = grid.buttons[i]; if (!button) return;
    const label = result ? id === 'match' ? 'matched' : 'built' : row.running.has(i) ? 'building' : 'waiting';
    button.className = 'unit' + (result ? id === 'match' ? ' matched' : ' done' : row.running.has(i) ? ' active' : '') + (i === grid.selected ? ' selected' : '');
    button.setAttribute('aria-label', `${row.names[i]}: ${label}`);
  };
  if (index === undefined) grid.buttons.forEach((_,i) => update(i)); else update(index);
  const suffix = scenario === 'game' && id === 'game-clang' ? '-clang' : '';
  if (scenario === 'game' || visiblePhase === id) {
    $('completed'+suffix).textContent = `${row.rows.size.toLocaleString()} / ${row.names.length.toLocaleString()} files & links`;
    $('progress'+suffix).max = row.names.length || 1; $('progress'+suffix).value = row.rows.size;
  }
}
function showPhase(id) {
  visiblePhase = id;
  $('phase-name').textContent = scenario === 'game' ? 'cppgm' : definitions[id].label;
  grids.clear();
  if (scenario === 'game') {makeGrid('game',$('units')); makeGrid('game-clang',$('units-clang'));}
  else makeGrid(id,$('units'));
  $('worker-count').textContent = phase(id).workers ? `${phase(id).workers} workers${scenario === 'game' ? ' each' : ''}` : '';
  $('unit-detail').textContent = 'Select a square to view its source.';
  selectProject(id); restoreProject(id); drawDownloads(); drawFlow();
}
function restoreProject(id) {
  projectEvent(id,'reset');
  for (const [index,result] of phase(id).rows) projectEvent(id,'unit',{name:phase(id).names[index], matched:id === 'match', seconds:result.seconds});
  for (const index of phase(id).running) projectEvent(id,'progress',{name:phase(id).names[index]});
}
function drawDownloads() {
  const fragment = document.createDocumentFragment();
  for (const id of paths[scenario]) {
    const row = phase(id), bytes = isGame(id) ? row.result?.game : id === 'match' ? row.result?.module : null;
    if (!bytes) continue;
    if (!downloads.has(row)) downloads.set(row,URL.createObjectURL(new Blob([bytes],{type:'application/wasm'})));
    const link = document.createElement('a'); link.href = downloads.get(row);
    link.download = isGame(id) ? `${target}-${id === 'game-clang' ? 'clang' : 'cppgm'}.wasm` : 'cppgm-rebuilt.wasm';
    link.textContent = link.download; fragment.append(link);
  }
  $('downloads').replaceChildren(fragment);
}
function terminate(id) {const job=jobs.get(id); if (!job) return; clearTimeout(job.deadline); job.session.terminate(); jobs.delete(id);}
function fail(message, cancelled=false) {
  if (!busy()) return;
  for (const id of [...jobs.keys()]) {
    const row=phase(id); row.seconds=seconds(row); row.compileSeconds=buildTime(row); row.state=cancelled?'cancelled':'failed'; row.running.clear();
    projectEvent(id,cancelled?'cancel':'error'); terminate(id); paintGrid(id);
  }
  comparisonInputs?.close();comparisonInputs=null;
  automatic=false; drawFlow(); $('status').textContent=cancelled?'Cancelled. Use Rerun to try again.':'Build stopped. Open build details for the error.';
  $('log').textContent+=message+'\n';
  window.lastWorkflowEvent={kind:cancelled?'cancelled':'error',error:message};
  window.lastGameBuild=window.lastInceptionEvent=window.lastWorkflowEvent;
}
function invalidate(id) {
  for (const row of state.invalidate(scenario,target,id)) if(downloads.has(row)){URL.revokeObjectURL(downloads.get(row));downloads.delete(row);}
}
function start(id, {rerun=false}={}) {
  if (busy() || !canRun(id)) return;
  if (!rerun && phase(id).state === 'done') {showPhase(id); return;}
  closeGame();
  if (rerun) invalidate(id);
  if (scenario === 'game') {
    comparisonInputs=new InputBroker();
    const workers = Math.min(3,Math.max(1,Math.floor(Number($('worker-choice').value)/2)));
    launch('game',{workers,barrier:true}); launch('game-clang',{workers,barrier:true,compiler:'clang'});
    showPhase(id);
  } else {launch(id,{workers:Number($('worker-choice').value)}); showPhase(id);}
}
function launch(id, args) {
  // Failed/cancelled attempts restart from clean inputs; completed rows are only
  // invalidated by the explicit rerun action.
  const row=phase(id); row.rows.clear(); row.running.clear(); row.state='active'; row.started=performance.now(); row.seconds=0; row.compileStarted=null;
  const session=new BuildSession('./'+definitions[id].worker,{workers:args.workers,maximum:isGame(id)?3:8,inputBroker:comparisonInputs});
  const job={session,ready:false,deadline:setTimeout(()=>fail('This phase exceeded the 90-minute deadline.'),90*60000)};
  jobs.set(id,job); row.workers=session.count;
  window.lastWorkflowEvent={kind:'starting',phase:id};
  if (id==='match') window.lastInceptionEvent={kind:'starting'};
  if (id==='game') window.lastGameBuild={kind:'starting'};
  if (id==='game-clang') window.lastClangGameBuild={kind:'starting'};
  if (id==='clang') {args.compilerBytes=phase('llvm').result.module;args.runtime=phase('llvm').result.runtime;}
  if (id==='match'&&scenario==='roundtrip') args.compilerBytes=phase('clang').result.module;
  if (isGame(id)&&scenario!=='game') args.compilerBytes=phase('match').result.module;
  projectEvent(id,'reset'); $('status').textContent=`Loading ${definitions[id].label} inputs…`;
  session.onerror=event=>fail(event.message);
  session.onmessage=({data})=>{
    if (!jobs.has(id)) return;
    const {module,game,runtime,assets,...summary}=data;
    window.lastWorkflowEvent={...summary,phase:id};
    if (id==='game') window.lastGameBuild=summary;
    else if (id==='game-clang') window.lastClangGameBuild=summary;
    else if (id==='match') window.lastInceptionEvent=summary;
    if (data.kind==='loading') $('status').textContent=data.message;
    if (data.kind==='ready') {
      row.names=id==='match'?[...data.sources,'Link cppgm']:[...data.sources];
      if (scenario==='game') makeGrid(id,$(id==='game-clang'?'units-clang':'units'));
      else if (visiblePhase===id) makeGrid(id,$('units'));
      $('worker-count').textContent=`${data.workerCount} workers${scenario==='game'?' each':''}`;
      if(data.revision)$('revision').textContent=`cppgm ${data.revision.slice(0,12)}`;
      if(data.seedSha256)$('log').textContent+=`Published seed SHA-256 ${data.seedSha256}\n`;
      drawFlow();
    }
    if (data.kind==='prepared') {
      job.ready=true;
      if ([...jobs.values()].every(job=>job.ready)) {
        const now=performance.now();
        for (const [id,job] of jobs) {phase(id).compileStarted=now;job.session.coordinator.postMessage({kind:'start'});}
        $('status').textContent='Both compilers ready. Building the same files.';
      } else $('status').textContent='Waiting for both compiler seeds before starting the comparison…';
    }
    if (data.kind==='progress') {
      row.names[data.index]=data.name;row.running.add(data.index);paintGrid(id,data.index);
      if(scenario!=='game'||visiblePhase===id)projectEvent(id,'progress',{name:data.name});$('status').textContent=data.name;
    }
    if (data.kind==='unit') {
      row.running.delete(data.index);row.rows.set(data.index,{seconds:data.seconds,bytes:data.bytes});paintGrid(id,data.index);
      row.peak=Math.max(row.peak||0,data.memoryBytes||0);$('memory').textContent=`${Math.ceil(row.peak/1048576)} MiB peak / worker`;
      if(scenario!=='game'||visiblePhase===id)projectEvent(id,'unit',{name:data.name,matched:id==='match',seconds:data.seconds});updateTime();
    }
    if (data.kind==='checking') $('status').textContent=`Checking ${data.name}…`;
    if (data.kind==='error') {fail(data.error);return;}
    if (data.kind==='complete') {
      if(scenario==='game'){
        const other=phase(id==='game'?'game-clang':'game').result;
        if(other){data.assets=other.assets;data.runtime=other.runtime;}
      }
      row.seconds=seconds(row);row.state='done';row.result=data;
      $('log').textContent+=`${id}: ${row.rows.size} outputs${id==='match'?', every byte matched':''} · ${row.seconds.toFixed(1)} s total${data.compileSeconds!==undefined?' · '+data.compileSeconds.toFixed(1)+' s build':''}\n`;
      terminate(id);drawFlow();drawDownloads();
      const index=paths[scenario].indexOf(id),next=paths[scenario][index+1];
      if (scenario==='game') {
        if(!busy()) {
          comparisonInputs?.close();comparisonInputs=null;
          const a=phase('game').result.compileSeconds,b=phase('game-clang').result.compileSeconds;
          $('status').textContent=`Built locally. cppgm ${a.toFixed(2)} s · clang ${b.toFixed(2)} s. Choose either Play button.`;
          if(automatic){automatic=false;openGame('game');}
        }
      } else {
        $('status').textContent=id==='match'?'Every object and the compiler match. Ready to build.':isGame(id)?'Built here. Ready to play.':`${definitions[id].label} built. Ready for the next phase.`;
        if(automatic&&next)start(next);
        else if(automatic&&isGame(id)){automatic=false;openGame(id);}
      }
    }
  };
  session.postMessage({...args,target,package:plan?.targets[target]?.package});
}
$('cancel').onclick=()=>fail('Build cancelled by the user.',true);
$('rerun-phase').onclick=()=>{automatic=false;start(visiblePhase,{rerun:true});};
$('run-workflow').onclick=()=>{
  if(completed()){showPhase(paths[scenario].at(-1));return;}
  automatic=true;start(paths[scenario].find(id=>phase(id).state!=='done'));
};
function chooseScenario(name) {
  if(busy())return;
  closeGame();scenario=name;showJourney(name);
  showPhase(paths[name].find(id=>phase(id).state!=='done')||paths[name].at(-1));
  $('status').textContent=completed()?'Results from this tab. Select a stage to review, or use Rerun.':name==='roundtrip'?'Optional long build. cppgm → clang → cppgm → matching cppgm → project.':'Choose a box to build, or run the whole workflow.';
}
for(const button of document.querySelectorAll('[data-journey]'))button.onclick=()=>chooseScenario(button.dataset.journey);
$('build-target').onchange=()=>{
  if(busy())return;
  target=$('build-target').value;closeGame();
  const item=plan?.targets[target];
  for(const id of ['game','game-clang']){definitions[id].label=item?.label||target;definitions[id].detail=`Compile & link ${item?.name||target}`;}
  $('target-note').textContent=item?.available?'':item?.reason||'Loading project information…';
  $('game-modal-title').textContent=`${item?.name||target} · built in your browser`;
  chooseScenario(scenario);
};
function closeGame(){if($('game-modal').open){$('game-modal').close();stopGame();}}
function stopGame(){
  if(!playing&&!opening&&!player)return;
  gameLaunch++;opening=false;player?.close();player=null;playing=false;window.gamePlaying=false;window.openLaraGame=null;
}
$('game-close').onclick=closeGame;$('game-modal').addEventListener('close',stopGame);
$('game-modal').addEventListener('click',event=>{if(event.target===$('game-modal')){const r=$('game-modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeGame();}});
async function openGame(id='game'){
  if(phase(id).state!=='done'||playing||opening)return;
  selectedGame=id;const launch=++gameLaunch;opening=true;
  $('game-modal').showModal();$('game-status').textContent='Opening the game you just built…';delete window.gameError;
  try{
    const url=window.incpptionPlayerURL||document.querySelector('meta[name=player-url]').content;
    player=new PlayerSession($('game-surface'),{url,log:text=>{$('log').textContent+=text+'\n';}});
    const game=await player.start(phase(selectedGame).result);if(launch!==gameLaunch)return;
    window.openLaraGame=game;opening=false;playing=true;window.gamePlaying=true;$('game-status').textContent='Running locally.';
  }catch(error){if(launch!==gameLaunch)return;opening=false;$('game-status').textContent=String(error);window.gameError=String(error);}
}
window.addEventListener('project-index-ready',({detail:{projects}})=>{
  for(const project of projects){
    if(project.id==='llvm')sourceNames.llvm=[...project.buildSources,'Link LLD','Link Clang'];
    if(project.id==='cppgm')sourceNames.match=sourceNames.clang=[...project.buildSources,'Link cppgm'];
    if(project.id==='game')sourceNames.game=sourceNames['game-clang']=[...project.buildSources,'Link OpenLara'];
  }
  for(const workflows of state.workflows.values())for(const [key,row]of workflows)if(row.state==='waiting')row.names=key.includes(':')&&!key.endsWith(':lara')?[]:sourceNames[key.split(':')[0]]||[];
  if(!busy())showPhase(visiblePhase);
});
fetch('./download-plan.json').then(response=>{if(!response.ok)throw Error('Download information unavailable');return response.json();}).then(value=>{plan=value;drawFlow();}).catch(error=>{$('status').textContent=String(error);});
setInterval(updateTime,250);
chooseScenario(['#inception','#roundtrip'].includes(location.hash)?location.hash.slice(1):'game');
