import {PlayerSession} from './player_session.mjs';
import {BuildSession} from './build_session.mjs';
import {buildPolicy, backgroundDataAllowed} from './build_policy.mjs';
import {InputBroker} from './input_broker.mjs';
import {showJourney} from './journey.mjs';
import {WorkflowState, paths, isGame} from './workflow_state.mjs';
import {BuildJournal} from './build_journal.mjs';
const $ = id => document.getElementById(id);
const definitions = {
  llvm: {label:'clang', detail:'cppgm builds clang + LLD', project:'llvm', worker:'llvm_worker.mjs'},
  clang: {label:'cppgm-clang', detail:'clang builds cppgm', project:'cppgm', worker:'clang_worker.mjs'},
  match: {label:'cppgm', detail:'Rebuild & match every byte', project:'cppgm', worker:'wasi_worker.mjs'},
  game: {label:'OpenLara', detail:'Compile & link OpenLara', project:'game', worker:'project_worker.mjs'},
  'game-clang': {label:'OpenLara', detail:'Compile & link OpenLara', project:'game', worker:'project_worker.mjs'},
};
const policy = buildPolicy(), journal = new BuildJournal();
const state = new WorkflowState(), jobs = new Map(), sourceNames = {}, grids = new Map(), downloads = new Map();
const requestedProject=new URLSearchParams(location.search).get('project');
let scenario, target = ['doom','lara','godot'].includes(requestedProject)?requestedProject:'lara', visiblePhase, automatic = false, player, playing = false, opening = false, gameLaunch = 0;
let selectedGame = 'game', plan, comparisonInputs, preloadTarget, comparisonPending = false, scrollOnReady = false;
const gameData=new Map();
const clock = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
const size = bytes => `${(bytes/1048576).toFixed(1)} MiB`;
const busy = () => jobs.size > 0;
$('worker-choice').value=String(policy.defaultWorkers);
for(const option of $('worker-choice').options)option.disabled=Number(option.value)>policy.maximum;
const canPlay=()=>target!=='doom'||typeof WebAssembly.promising==='function'&&typeof WebAssembly.Suspending==='function';
function targetNote(){
 const item=plan?.targets[target];
 $('target-note').textContent=!item?.available?item?.reason||'Loading project information…':!canPlay()?'Doom play needs JSPI support. Use Chrome or choose another project.':item?.longBuild?'Long build':'';
}
const phase = id => state.phase(scenario,target,id,sourceNames[isGame(id)?target:id]||[]);
const projectId=id=>isGame(id)?target:definitions[id].project;
window.activeBuildTarget=target;
const seconds = row => row.state === 'active' ? (performance.now()-row.started)/1000 : row.seconds;
function buildTime(row) {
  if(row.result?.compileSeconds!==undefined)return row.result.compileSeconds;
  if(!row.compileStarted)return 0;
  return row.state==='active'?((row.compilePaused||performance.now())-row.compileStarted-(row.loadingMs||0))/1000:row.compileSeconds||0;
}
function phaseClock(row) {
  if(scenario!=='game')return clock(seconds(row));
  return row.state==='active'&&!row.compileStarted?'loading':clock(buildTime(row));
}
const completed = () => state.completed(scenario, target);
const projectEvent = (id, kind, detail = {}) => window.dispatchEvent(new CustomEvent('project-build', {detail:{project:projectId(id), kind, ...detail}}));
function selectProject(id) {
  const project=projectId(id);
  window.dispatchEvent(new CustomEvent('project-select', {detail:{project}}));
}
function canRun(id) {
  if (isGame(id) && !plan?.targets[target]?.available) return false;
  if (scenario === 'game') return true;
  const index = paths[scenario].indexOf(id);
  return index === 0 || phase(paths[scenario][index-1]).state === 'done';
}
function downloadFiles(ids) {return new Set(ids.flatMap(id => (isGame(id)?plan?.targets[target]?.stages?.[id]:plan?.stages[id]) || []));}
function downloadSize(ids) {return [...downloadFiles(ids)].reduce((total,name) => total + (plan?.files[name] || 0), 0);}
const fileSize=files=>(files||[]).reduce((total,name)=>total+(plan?.files[name]||0),0);
const gameDataSize=()=>fileSize(plan?.targets[target]?.playFiles?.filter(path=>path.includes('/assets/')));
function updateBadges() {
  for (const badge of document.querySelectorAll('[data-flow-size]')) {
    const bytes = [...new Set([...downloadFiles(paths[badge.dataset.flowSize]),...(plan?.targets[target]?.playFiles||[])])].reduce((n,path)=>n+(plan?.files[path]||0),0);
    badge.textContent = plan && !plan.targets[target]?.available ? badge.dataset.flowSize === 'game' ? 'Package pending' : '≥ '+size(bytes)+' + project' : bytes ? size(bytes) : '';
    if(bytes&&plan?.targets[target]?.available){
      const total=document.createElement('span');total.className='download-total';total.textContent=size(bytes)+' total';badge.replaceChildren(total);
      if(gameDataSize()){const data=document.createElement('span');data.className='download-data';data.textContent='incl. '+size(gameDataSize())+' game data';badge.append(data);}
    }
    badge.title = 'Cold download, shared files counted once. Cached files may need no transfer.';
  }
}
function addFlow(list, ids, compiler) {
  const fragment = document.createDocumentFragment(), seed = document.createElement('li');
  seed.className = 'endpoint seed';
  seed.innerHTML = `<span class="dot" aria-hidden="true"></span><strong>${compiler} seed</strong><small>${compiler === 'cppgm' ? 'Self-compiled Wasm' : 'Wasm · clang 22'}</small><small class="setup-download" title="Compiler setup downloads before compilation starts. Clang includes LLD; both lanes use the same project inputs.">Setup ↓ ${size(fileSize(plan?.setup?.[compiler]))}</small>`;
  fragment.append(seed);
  for (const id of ids) {
    const row = phase(id), definition = definitions[id], node = document.createElement('li');
    node.className = `flow-node ${row.state}${visiblePhase === id ? ' selected' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.phase = id;
    button.disabled = row.state !== 'done' && !canRun(id) || busy() && row.state === 'waiting';
    button.innerHTML = `<span class="node-name">${definition.label}<span class="node-check">${row.state === 'done' ? id === 'match' ? '✓ matches' : '✓' : ''}</span></span><span class="node-description">${row.stoppedForPlay?'Stopped to play':definition.detail}</span><span class="node-stats"><span>${row.rows.size} / ${row.names.length || '…'}</span><time>${phaseClock(row)}</time></span><span class="node-download" title="${isGame(id)?'Identical source, headers and SDK in both lanes; downloaded once, before compilation.':'Cold stage download; shared inputs counted once in the workflow badge.'}">${isGame(id)?'Shared inputs':'Inputs'} ↓ ${isGame(id) && plan && !plan.targets[target]?.available ? 'Package pending' : size(isGame(id)?fileSize(plan?.targets[target]?.inputs):downloadSize([id]))}</span>`;
    button.setAttribute('aria-label', `${definition.label}: ${row.state === 'done' ? id === 'match' ? 'matches, view results' : 'built, view results' : row.state === 'active' ? 'building, view progress' : 'build phase'}`);
    button.onclick = () => {
      if (row.state === 'done' || row.state === 'active') {showPhase(id); return;}
      automatic = false; start(id);
    };
    const action=document.createElement('span');action.className='flow-action';action.textContent='compile';node.append(action);
    node.append(button); fragment.append(node);
  }
  const end = document.createElement('li'), gameId = compiler === 'clang' ? 'game-clang' : 'game';
  end.className = 'endpoint finish' + (phase(gameId).state === 'done' ? ' done' : '');
  const runAction=document.createElement('span');runAction.className='flow-action';runAction.textContent='run';end.append(runAction);
  const play = document.createElement('button'); play.id = compiler === 'clang' ? 'game-play-clang' : 'game-play'; play.type = 'button';
  play.disabled = phase(gameId).state !== 'done' || busy() || !canPlay();
  play.innerHTML = `<span class="dot" aria-hidden="true">▶</span><strong>${plan?.targets[target]?.kind === 'editor' ? 'Open' : 'Play'}</strong><small title="Additional player and game-data download">↓ ${size((plan?.targets[target]?.playFiles||[]).reduce((n,path)=>n+(plan?.files[path]||0),0))}</small>`;
  play.onclick = () => openGame(gameId); end.append(play); fragment.append(end);
  list.replaceChildren(fragment);
}
function drawFlow() {
  const comparison = scenario === 'game';
  if(comparison&&Number($('worker-choice').value)<2)$('worker-choice').value='2';
  for(const option of $('worker-choice').options){
    const count=Number(option.value);option.hidden=comparison&&count===1;option.disabled=count>policy.maximum||option.hidden;
    option.textContent=comparison&&count>1?`${count/2} each`:String(count);
  }
  $('worker-choice').title=comparison?'Workers for each compiler; both lanes use the same count':'Workers for the current build stage';
  $('flow-rows').classList.toggle('comparison', comparison);
  $('build-grids').classList.toggle('comparison', comparison);
  document.body.classList.toggle('building', busy());
  $('flow-clang').hidden = !comparison; $('clang-results').hidden = !comparison;
  addFlow($('flow'), comparison ? ['game'] : paths[scenario], 'cppgm');
  if (comparison) addFlow($('flow-clang'), ['game-clang'], 'clang');
  $('run-workflow').disabled = busy() || !plan?.targets[target]?.available;
  $('run-workflow').textContent = completed() ? 'View results' : comparison ? 'Start comparison →' : 'Run workflow →';
  $('cancel').disabled = !busy(); $('worker-choice').disabled = busy(); $('build-target').disabled = busy();
  $('clang-results').querySelector('strong').textContent=phase('game-clang').stoppedForPlay?'clang · stopped':'clang';
  $('rerun-phase').disabled = busy() || !visiblePhase || phase(visiblePhase).state === 'waiting' || !canRun(visiblePhase);
  $('rerun-phase').title = comparison ? 'Rerun both compilers' : 'Rerun this stage and clear later results';
  $('comparison-note').textContent = comparison ? 'Both compilers use the same source, SDK, O3 settings and worker count.' : '';
  for (const button of document.querySelectorAll('[data-journey]')) button.disabled = busy();
  updateTime(); updateBadges(); drawComparison(); drawGameData();
}
function drawComparison(){
  const result=$('comparison-result'),a=phase('game'),b=phase('game-clang');
  result.hidden=scenario!=='game'||a.state!=='done'||b.state!=='done';
  if(result.hidden){result.replaceChildren();return;}
  const cppgm=a.result.compileSeconds,clang=b.result.compileSeconds;
  if(!(cppgm>0&&clang>0)){result.hidden=true;return;}
  const winner=cppgm<=clang?'cppgm':'clang',ratio=Math.max(cppgm,clang)/Math.min(cppgm,clang);
  result.innerHTML=`<strong>${ratio.toFixed(2)}×</strong><span>${cppgm===clang?'Equal build times':winner+' faster'}<span class="comparison-times">cppgm ${cppgm.toFixed(2)} s · clang ${clang.toFixed(2)} s</span></span>`;
}
function canPreloadGameData(){return backgroundDataAllowed({lowMemory:policy.lowMemory,activeBuilds:jobs.size,bytes:gameDataSize()});}
function drawGameData(){
  const element=$('game-data-download'),row=gameData.get(target);
  element.hidden=!row&&!gameDataSize();
  if(!row){element.querySelector('span').textContent=`Game data ↓ ${size(gameDataSize())} · included in totals · ${backgroundDataAllowed({lowMemory:policy.lowMemory,activeBuilds:1,bytes:gameDataSize()})?'downloads during compilation':'downloads after compilation'}`;element.querySelector('progress').hidden=true;return;}
  element.querySelector('span').textContent=row.error?'Game data will download when you open the game.':row.done?`Game data ready · ${size(row.total)} cached`:`Game data ↓ ${size(row.loaded)} / ${size(row.total)} · ${row.paused?'paused':'downloading in background'}`;
  const progress=element.querySelector('progress');progress.hidden=!!row.error;progress.max=row.total||1;progress.value=row.loaded;
}
function ensurePlayer(){
  if(!player){
    const url=window.incpptionPlayerURL||document.querySelector('meta[name=player-url]').content;
    player=new PlayerSession($('game-surface'),{url,log:text=>{$('log').textContent+=text+'\n';}});
    player.onprogress=({loaded,total})=>{$('game-status').textContent=`Loading project data: ${size(loaded)} / ${size(total)}`;};
  }
  return player;
}
function preloadGameData(id){
  if(policy.lowMemory&&!isGame(id)||!canPreloadGameData())return;
  const descriptor=plan?.targets[target]?.player;
  if(!canPlay()||!descriptor?.assets.length||preloadTarget===target)return;
  const project=target;preloadTarget=project;
  const session=ensurePlayer();
  const update=data=>{
    const row=gameData.get(project)||{loaded:0,total:descriptor.assets.reduce((n,a)=>n+a.chunks.reduce((n,c)=>n+(c.encoded_bytes||c.size),0),0)};
    if(data.kind==='preload-progress')Object.assign(row,{loaded:data.loaded,total:data.total,done:false,error:null,paused:false});
    if(data.kind==='preload-complete')row.done=true;
    if(data.kind==='preload-error')row.error=data.error;
    gameData.set(project,row);window.lastGameDataDownload={project,...row};drawGameData();
  };
  session.onpreload=update;
  update({kind:'preload-progress',loaded:0,total:descriptor.assets.reduce((n,a)=>n+a.chunks.reduce((n,c)=>n+(c.encoded_bytes||c.size),0),0)});
  session.preload({...descriptor,baseURL:new URL(descriptor.baseURL,location.href).href}).catch(error=>update({kind:'preload-error',error:String(error)}));
}
function updateTime() {
  $('workflow-time').textContent = clock(state.totalSeconds(scenario, target, seconds));
  const rows = paths[scenario].map(phase), count = rows.reduce((n,row) => n+row.rows.size,0), total = rows.reduce((n,row) => n+row.names.length,0);
  $('workflow-files').textContent = total ? `${count.toLocaleString()} / ${total.toLocaleString()} files` : '';
  for (const button of document.querySelectorAll('[data-phase]')) {
    const id = button.dataset.phase, row = phase(id);
    button.querySelector('time').textContent = phaseClock(row);
    button.querySelector('.node-stats span').textContent = `${row.rows.size} / ${row.names.length || '…'}`;
  }
  if (visiblePhase) $('elapsed').textContent = phaseClock(phase(scenario==='game'?'game':visiblePhase));
  if (scenario === 'game') $('elapsed-clang').textContent = phaseClock(phase('game-clang'));
}
function sizeGrid(element){
  const width=element.clientWidth,count=Number(element.dataset.units)||0;
  if(!width||!count)return;
  const gap=count>512?2:3,height=width<600?180:200,cell=width<600?10:16;
  const columns=Math.max(Math.ceil((width+gap)/(cell+gap)),Math.ceil(Math.sqrt(count*width/height)));
  element.style.gridTemplateColumns=`repeat(${columns},minmax(0,1fr))`;
  element.style.gap=gap+'px';
}
const gridSizer=new ResizeObserver(entries=>{requestAnimationFrame(()=>{for(const entry of entries)sizeGrid(entry.target);});});
function makeGrid(id, element) {
  const row = phase(id), buttons = [], fragment = document.createDocumentFragment();
  element.classList.toggle('dense', row.names.length > 1000);
  for (const [index,name] of row.names.entries()) {
    const button = document.createElement('button'); button.className = 'unit'; button.type = 'button'; button.title = name;
    button.onclick = () => {
      const result = row.rows.get(index), grid = grids.get(id); grid.selected = index;
      $('unit-detail').textContent = `${scenario === 'game' ? id === 'game-clang' ? 'clang · ' : 'cppgm · ' : ''}${name}${result ? ' · '+result.seconds.toFixed(2)+' s'+(id === 'match' ? ' · matched' : ' · built') : row.running.has(index) ? ' · building' : ' · waiting'}`;
      const source=row.sources?.[index]||name;
      if (source.includes('/')) window.dispatchEvent(new CustomEvent('project-source-select', {detail:{project:projectId(id), path:source}}));
      paintGrid(id);
    };
    buttons.push(button); fragment.append(button);
  }
  element.replaceChildren(fragment);element.dataset.units=row.names.length;sizeGrid(element);gridSizer.observe(element);grids.set(id,{buttons, selected:-1});paintGrid(id);
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
    $('completed'+suffix).textContent = `${row.rows.size.toLocaleString()} / ${row.names.length.toLocaleString()}`;
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
  for (const [index,result] of phase(id).rows) projectEvent(id,'unit',{name:phase(id).sources?.[index]||phase(id).names[index], matched:id === 'match', seconds:result.seconds});
  for (const index of phase(id).running) projectEvent(id,'progress',{name:phase(id).sources?.[index]||phase(id).names[index]});
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
function terminate(id) {journal.finish(id);const job=jobs.get(id); if (!job) return; clearTimeout(job.deadline); job.session.terminate(); jobs.delete(id);}
function fail(message, cancelled=false) {
  if (!busy()) return;
  closeCompletion();
  for (const id of [...jobs.keys()]) {
    const row=phase(id); row.seconds=seconds(row); row.compileSeconds=buildTime(row); row.state=cancelled?'cancelled':'failed'; row.running.clear();
    projectEvent(id,cancelled?'cancel':'error'); terminate(id); paintGrid(id);
  }
  comparisonInputs?.close();comparisonInputs=null;
  closeGame();stopGame();
  automatic=false; drawFlow(); $('status').classList.remove('sr-only'); $('status').textContent=cancelled?'Cancelled. Use Rerun to try again.':'Build stopped. Open Diagnostics for the error.';
  $('log').textContent+=message+'\n';
  if(!cancelled)document.querySelector('.diagnostics').open=true;
  window.lastWorkflowEvent={kind:cancelled?'cancelled':'error',error:message};
  window.lastGameBuild=window.lastInceptionEvent=window.lastWorkflowEvent;
}
function invalidate(id) {
  for (const row of state.invalidate(scenario,target,id)) if(downloads.has(row)){URL.revokeObjectURL(downloads.get(row));downloads.delete(row);}
}
const workflowToolbar=document.querySelector('.workflow-toolbar');
function measureToolbar(){
  const height=Math.ceil(workflowToolbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--workflow-toolbar-height',height+'px');
  return height;
}
new ResizeObserver(measureToolbar).observe(workflowToolbar);
for(const type of ['wheel','touchmove'])window.addEventListener(type,()=>{scrollOnReady=false;},{passive:true});
window.addEventListener('keydown',event=>{if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key))scrollOnReady=false;});
function scrollToBuild(){
  // Wait for the active toolbar, file counts and grids to settle before measuring.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const offset=measureToolbar()+16,rect=$('build-grids').getBoundingClientRect();
    const delta=policy.handheld||rect.top<offset?rect.top-offset:Math.max(0,Math.min(rect.top-offset,rect.bottom-innerHeight+24));
    window.scrollBy({top:delta,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }));
}
function start(id, {rerun=false,scroll=true}={}) {
  if (busy() || !canRun(id)) return;
  if (!rerun && phase(id).state === 'done') {showPhase(id); return;}
  closeCompletion();closeGame();scrollOnReady=scroll;
  $('status').classList.add('sr-only');
  if (rerun) invalidate(id);
  if (scenario === 'game') {
    comparisonInputs=new InputBroker();
    const workers = Math.min(4,Math.max(1,Math.floor(Math.min(policy.maximum,Number($('worker-choice').value))/2)));
    launch('game',{workers,barrier:true}); launch('game-clang',{workers,barrier:true,compiler:'clang'});
    showPhase(id);
  } else {launch(id,{workers:Number($('worker-choice').value)}); showPhase(id);}
  if(scroll)scrollToBuild();
}
function launch(id, args) {
  // Failed/cancelled attempts restart from clean inputs; completed rows are only
  // invalidated by the explicit rerun action.
  const row=phase(id); row.rows.clear(); row.running.clear(); row.state='active'; row.started=performance.now(); row.seconds=0; row.compileStarted=null; row.compileSeconds=0; row.loadingMs=0; row.compilePaused=null; row.result=null; row.peak=0; row.stoppedForPlay=false;
  const session=new BuildSession('./'+definitions[id].worker,{workers:args.workers,maximum:8,inputBroker:comparisonInputs});
  const job={session,ready:false,deadline:setTimeout(()=>fail('This phase exceeded the 90-minute deadline.'),90*60000)};
  jobs.set(id,job); row.workers=session.count;
  journal.update(id,{project:target,workflow:scenario,label:definitions[id].label,step:'Loading compiler',workers:session.count},true);
  window.lastWorkflowEvent={kind:'starting',phase:id};
  if (id==='match') window.lastInceptionEvent={kind:'starting'};
  if (id==='game') window.lastGameBuild={kind:'starting'};
  if (id==='game-clang') window.lastClangGameBuild={kind:'starting'};
  if (id==='clang') {args.compilerBytes=phase('llvm').result.module;args.runtime=phase('llvm').result.runtime;}
  if (id==='match'&&scenario==='roundtrip') args.compilerBytes=phase('clang').result.module;
  if (isGame(id)&&scenario!=='game') args.compilerBytes=phase('match').result.module;
  projectEvent(id,'reset'); $('status').textContent=`Loading ${definitions[id].label} inputs…`;
  session.onerror=event=>{if(jobs.get(id)===job)fail(event.message||'The compiler could not start. Reload the page and try again.');};
  session.onmessage=({data})=>{
    if (jobs.get(id)!==job) return;
    const {module,game,runtime,assets,...summary}=data;
    if(['loading','ready','prepared','progress','unit','checking','link-preparing'].includes(data.kind))
      journal.update(id,{project:target,workflow:scenario,label:definitions[id].label,step:data.name||data.message||data.kind,completed:row.rows.size,total:row.names.length,memoryBytes:data.memoryBytes});
    window.lastWorkflowEvent={...summary,phase:id};
    if (id==='game') window.lastGameBuild=summary;
    else if (id==='game-clang') window.lastClangGameBuild=summary;
    else if (id==='match') window.lastInceptionEvent=summary;
    if (data.kind==='loading') $('status').textContent=data.message;
    if (data.kind==='ready') {
      row.names=id==='match'?[...data.sources,'Link cppgm']:[...data.sources];row.sources=data.unitSources||row.names;
      if (scenario==='game') makeGrid(id,$(id==='game-clang'?'units-clang':'units'));
      else if (visiblePhase===id) makeGrid(id,$('units'));
      $('worker-count').textContent=`${data.workerCount} workers${scenario==='game'?' each':''}`;
      if(data.revision)$('revision').textContent=`cppgm ${data.revision.slice(0,12)}`;
      if(data.seedSha256)$('log').textContent+=`Published seed SHA-256 ${data.seedSha256}\n`;
      drawFlow();if(scrollOnReady)scrollToBuild();
      if(scenario!=='game')scrollOnReady=false;
    }
    if (data.kind==='prepared') {
      job.ready=true;
      if ([...jobs.values()].every(job=>job.ready)) {
        scrollOnReady=false;
        const now=performance.now();
        for (const [id,job] of jobs) {phase(id).compileStarted=now;job.session.coordinator.postMessage({kind:'start'});}
        $('status').textContent='Both compilers ready. Building the same files.';
        preloadGameData(id);
      } else $('status').textContent='Waiting for both compiler seeds before starting the comparison…';
    }
    if(data.kind==='link-preparing')row.compilePaused=performance.now();
    if(data.kind==='link-ready'&&row.compilePaused){row.loadingMs+=performance.now()-row.compilePaused;row.compilePaused=null;}
    if (data.kind==='progress') {
      preloadGameData(id);
      row.names[data.index]=data.name;row.running.add(data.index);paintGrid(id,data.index);
      if(scenario!=='game'||visiblePhase===id)projectEvent(id,'progress',{name:data.source||data.name});$('status').textContent=data.name;
    }
    if (data.kind==='unit') {
      row.running.delete(data.index);row.rows.set(data.index,{seconds:data.seconds,bytes:data.bytes});paintGrid(id,data.index);
      row.peak=Math.max(row.peak||0,data.memoryBytes||0);$('memory').textContent=`${Math.ceil(row.peak/1048576)} MiB peak / worker`;
      if(scenario!=='game'||visiblePhase===id)projectEvent(id,'unit',{name:data.source||data.name,matched:id==='match',seconds:data.seconds});updateTime();
    }
    if (data.kind==='checking') $('status').textContent=`Checking ${data.name}…`;
    if (data.kind==='error') {fail(data.error);return;}
    if (data.kind==='complete') {
      row.seconds=seconds(row);row.state='done';row.result=data;
      $('log').textContent+=`${id}: ${row.rows.size} outputs${id==='match'?', every byte matched':''} · ${row.seconds.toFixed(1)} s total${data.compileSeconds!==undefined?' · '+data.compileSeconds.toFixed(1)+' s build':''}\n`;
      terminate(id);if(isGame(id))preloadGameData(id);drawFlow();drawDownloads();
      const index=paths[scenario].indexOf(id),next=paths[scenario][index+1];
      if (scenario==='game') {
        if(id==='game'&&busy()&&canPlay())showCompletion();
        if(!busy()) {
          comparisonInputs?.close();comparisonInputs=null;
          const a=phase('game').result.compileSeconds,b=phase('game-clang').result.compileSeconds;
          $('status').textContent=`Built locally. cppgm ${a.toFixed(2)} s · clang ${b.toFixed(2)} s. Choose either Play button.`;
          const play=automatic||comparisonPending||id==='game';
          automatic=false;closeCompletion();
          if(play){if(canPlay())openGame('game');else $('status').textContent='Built locally. This browser needs JSPI support to play Doom.';}
        }
      } else {
        $('status').textContent=id==='match'?'Every object and the compiler match. Ready to build.':isGame(id)?'Built here. Ready to play.':`${definitions[id].label} built. Ready for the next phase.`;
        if(automatic&&next)start(next,{scroll:false});
        else if(automatic&&isGame(id)){automatic=false;if(canPlay())openGame(id);else $('status').textContent='Built locally. This browser needs JSPI support to play Doom.';}
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
  $('status').classList.add('sr-only');
  closeCompletion();closeGame();scenario=name;showJourney(name);
  showPhase(paths[name].find(id=>phase(id).state!=='done')||paths[name].at(-1));
  $('status').textContent=completed()?'Results from this tab. Select a stage to review, or use Rerun.':name==='roundtrip'?'Optional long build. cppgm → clang → cppgm → matching cppgm → project.':'Choose a box to build, or run the whole workflow.';
}
const journeyTabs=[...document.querySelectorAll('[data-journey]')];
for(const button of journeyTabs){
  button.onclick=()=>chooseScenario(button.dataset.journey);
  button.onkeydown=event=>{
    const offset={ArrowRight:1,ArrowLeft:-1}[event.key];
    if(!offset&&event.key!=='Home'&&event.key!=='End')return;
    event.preventDefault();
    const next=journeyTabs[event.key==='Home'?0:event.key==='End'?journeyTabs.length-1:(journeyTabs.indexOf(button)+offset+journeyTabs.length)%journeyTabs.length];
    next.focus();chooseScenario(next.dataset.journey);
  };
}
$('build-target').onchange=()=>{
  if(busy())return;
  closeGame();stopGame();target=$('build-target').value;window.activeBuildTarget=target;
  const item=plan?.targets[target];
  for(const id of ['game','game-clang']){definitions[id].label=item?.label||target;definitions[id].detail=`Compile & link ${item?.name||target}`;}
  targetNote();
  $('game-modal-title').textContent=`${item?.name||target} · built in your browser`;
  updateRoutes();chooseScenario(scenario);
};
function closeCompletion(){
  comparisonPending=false;
  if($('completion-modal').open)$('completion-modal').close();
}
function showCompletion(){
  comparisonPending=true;
  $('completion-message').textContent='Play now stops clang. Or wait for the full comparison.';
  $('completion-wait').disabled=false;$('completion-wait').textContent='Wait for clang';
  $('completion-modal').show();
}
function stopClangForPlay(){
  const id='game-clang';if(!jobs.has(id))return;
  const row=phase(id);row.seconds=seconds(row);row.compileSeconds=buildTime(row);row.state='cancelled';row.stoppedForPlay=true;row.running.clear();
  terminate(id);comparisonInputs?.close();comparisonInputs=null;projectEvent(id,'cancel');paintGrid(id);drawFlow();
  window.lastClangGameBuild={kind:'cancelled',reason:'play',compileSeconds:row.compileSeconds};
  window.lastWorkflowEvent={...window.lastClangGameBuild,phase:id};
  $('status').textContent='Clang stopped. Playing the cppgm build.';$('log').textContent+='Clang stopped to release compiler memory before playback. No comparison result.\n';
}
$('completion-play').onclick=async()=>{
  const project=target,workflow=scenario;
  automatic=false;closeCompletion();stopClangForPlay();
  // Give terminated compiler workers a turn to tear down before loading the game.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(target===project&&scenario===workflow)openGame('game');
};
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('completion-modal').open){event.preventDefault();$('completion-modal').close();}
});
$('completion-wait').onclick=()=>{
  $('completion-message').textContent='Clang is still compiling. Your game will open when it finishes.';
  $('completion-wait').disabled=true;$('completion-wait').textContent='Waiting for clang…';
};
function closeGame(){if($('game-modal').open){$('game-modal').close();stopGame();}}
function stopGame(){
  if(!playing&&!opening&&!player)return;
  const download=gameData.get(preloadTarget);if(download&&!download.done)download.paused=true;
  gameLaunch++;opening=false;player?.close();player=null;preloadTarget=null;playing=false;window.gamePlaying=false;window.openLaraGame=null;
  drawGameData();
}
$('game-close').onclick=closeGame;$('game-modal').addEventListener('close',stopGame);
$('game-modal').addEventListener('click',event=>{if(event.target===$('game-modal')){const r=$('game-modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeGame();}});
async function openGame(id='game'){
  if(phase(id).state!=='done'||playing||opening)return;
  selectedGame=id;const launch=++gameLaunch;opening=true;
  $('game-modal-title').textContent=`${plan.targets[target].name} · built in your browser`;$('game-help').textContent=target==='godot'?'Create or open a project in the editor. Close to return to the build.':target==='doom'?'WASD to move · Mouse to aim and fire · Space to jump · Esc for menu. Touch controls are below the game.':'Arrow keys to move · Ctrl to act · Alt to jump · Esc for menu. Touch controls are below the game.';$('game-modal').showModal();$('game-status').textContent='Opening the game you just built…';delete window.gameError;
  try{
    ensurePlayer();
    const game=await player.start(phase(selectedGame).result);if(launch!==gameLaunch)return;
    window.openLaraGame=game;opening=false;playing=true;window.gamePlaying=true;$('game-status').textContent='Running locally.';
  }catch(error){if(launch!==gameLaunch)return;opening=false;$('game-status').textContent=String(error);window.gameError=String(error);}
}
window.addEventListener('project-index-ready',({detail:{projects}})=>{
  for(const project of projects){
    if(project.id==='llvm')sourceNames.llvm=[...project.buildSources,'Link LLD','Link clang'];
    if(project.id==='cppgm')sourceNames.match=sourceNames.clang=[...project.buildSources,'Link cppgm'];
    if(['lara','doom','godot'].includes(project.id))sourceNames[project.id]=project.buildUnits.map(row=>row.name);
  }
  for(const workflows of state.workflows.values())for(const [key,row]of workflows)if(row.state==='waiting')row.names=sourceNames[key.includes(':')?key.split(':')[1]:key]||[];
  if(!busy())showPhase(visiblePhase);
});
function updateRoutes(){
  const project=plan?.targets[target]?.label||'OpenLara';
  const routes={game:[['cppgm',project],['clang',project]],inception:[['cppgm','cppgm ✓',project]],roundtrip:[['cppgm','clang','cppgm','cppgm ✓',project]]};
  for(const caption of document.querySelectorAll('[data-route]')){
    const fragment=document.createDocumentFragment();
    for(const chain of routes[caption.dataset.route]){
      const line=document.createElement('span');line.className='route-chain';
      const start=document.createElement('span');start.textContent=chain[0];line.append(start);
      for(const name of chain.slice(1)){
        const step=document.createElement('span');step.className='route-step';
        const verb=document.createElement('span');verb.className='route-verb';verb.innerHTML='compile<span aria-hidden="true">→</span>';
        const end=document.createElement('span');end.textContent=name;step.append(verb,end);line.append(step);
      }
      fragment.append(line);
    }
    caption.replaceChildren(fragment);
  }
}
fetch('./download-plan.json').then(response=>{if(!response.ok)throw Error('Download information unavailable');return response.json();}).then(value=>{plan=value;$('build-target').value=target;for(const id of ['game','game-clang']){definitions[id].label=plan.targets[target].label;definitions[id].detail='Compile & link '+plan.targets[target].name;}targetNote();updateRoutes();showPhase(visiblePhase);}).catch(error=>{$('status').textContent=String(error);});
updateRoutes();setInterval(updateTime,250);
chooseScenario(['#inception','#roundtrip'].includes(location.hash)?location.hash.slice(1):'game');

if(journal.previous?.phases.length){
  window.lastInterruptedBuild=journal.previous;
  document.querySelector('.diagnostics').open=true;
  const steps=journal.previous.phases.map(row=>`${row.id}: ${row.label||row.project} · ${row.step||'building'}`).join('\n');
  $('log').textContent+=`Previous build was interrupted by a page reload. Last saved steps:\n${steps}\n`;
}
