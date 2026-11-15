import {fetchBytes} from './transport_bytes.mjs';
import {highlight, highlightCode} from './highlight.mjs';
import {ProjectTree} from './project_tree.mjs';
const $ = id => document.getElementById(id);
const example = `// Edit this example, then compile for either target.\nextern "C" int answer(int n) {\n    int total = 0;\n    for (int i = 0; i < n; ++i)\n        total += i * i;\n    return total;\n}\n`;
let projects = [], project, active, worker, result, url, busy = false, deadline, request = 0;
let editedExample = example, currentTab = 'source';
const builds = new Map(), generations = new Map();
const textUrls = new Map(), sourceCache=new Map();
function outputView(id, code, language) {
  const end = Math.min(code.length, 120000);
  const cut = code.length > end ? Math.max(code.lastIndexOf('\n', end), 0) || end : end;
  const truncated = cut < code.length;
  highlightCode($(id + '-code'), code.slice(0, cut), language);
  $(id + '-preview').textContent = truncated ? 'Showing the beginning. Download the complete output to see every line.' : '';
  const link = $(id + '-download');
  if (textUrls.has(id)) URL.revokeObjectURL(textUrls.get(id));
  const url = URL.createObjectURL(new Blob([code], {type: 'text/plain;charset=utf-8'}));
  textUrls.set(id, url);
  link.href = url; link.hidden = false;
  link.download = `${active.path.split('/').at(-1)}.${id === 'lowir' ? 'lowir' : language === 'wasm' ? 'wat' : 'asm'}`;
}
function buildState(id) {if (!builds.has(id)) builds.set(id, new Map()); return builds.get(id);}
const tree = new ProjectTree($('source-files'), {onSelect: file => choose(file), onSummary: summary => {
  $('file-count').textContent = summary.total ? `${summary.done}/${summary.total} ${project?.id === 'cppgm' ? 'matched' : 'built'}` : 'Editable';
}});
function view(tab) {
  currentTab = tab;
  for (const id of ['source', 'lowir', 'generated']) {
    $(`pane-${id}`).hidden = id !== tab;
    $(`tab-${id}`).setAttribute('aria-selected', String(id === tab));
    $(`tab-${id}`).tabIndex = id === tab ? 0 : -1;
  }
}
for (const id of ['source', 'lowir', 'generated']) {
  $(`tab-${id}`).onclick = () => view(id);
  $(`tab-${id}`).onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = ['source', 'lowir', 'generated'];
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2
      : (tabs.indexOf(id) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    view(tabs[next]); $(`tab-${tabs[next]}`).focus();
  };
}
function clearOutput() {
  result = null; $('run-example').disabled = true; $('object-download').hidden = true;
  for (const id of ['lowir', 'generated']) {
    if (textUrls.has(id)) URL.revokeObjectURL(textUrls.get(id));
    textUrls.delete(id); $(id + '-download').hidden = true; $(id + '-preview').textContent = '';
  }
  highlightCode($('lowir-code'), '// Compile the selected source file to see its optimized LowIR.', 'lowir');
  highlightCode($('generated-code'), ';; Compile the selected source file to see generated code.', $('inspect-target').value === 'wasm' ? 'wasm' : 'x86');
}
function paintSource() {$('source-highlight').innerHTML = highlight($('source-code').value + '\n', 'cpp');}
function canCompile() {return active && (project.id === 'example' || project.buildSources.includes(active.path));}
function controls() {
  $('compile-example').disabled = busy || !canCompile();
  $('inspect-cancel').disabled = !busy;
  $('inspect-target').disabled = busy;
  $('source-code').readOnly = busy || project?.id !== 'example';
  $('compile-example').textContent = project?.id === 'example' ? 'Compile example' : 'Compile selected file';
  $('run-example').hidden = project?.id !== 'example';
}
function fileState() {
  const row = project && active && buildState(project.id).get(active.path);
  $('source-state').textContent = row?.state === 'matched' ? '✓ Bytes matched' : row?.state === 'built' ? 'Built locally'
    : row?.state === 'running' ? 'Building locally…' : row?.state === 'failed' ? 'Build stopped'
    : project?.id === 'example' ? 'Editable example' : canCompile() ? /\.[Ss]$/.test(active.path)?'WebAssembly assembly source':active.path.endsWith('.c')?'C source file':'C++ source file' : 'Header input';
}
function renderTree() {
  if (!project) return;
  const all = $('show-inputs').checked || $('file-filter').value.length > 0;
  const files = all || project.id === 'example' ? project.files : project.files.filter(file => project.buildSources.includes(file.path));
  tree.setProject({...project, files, flat: project.id === 'game' && !all}, active?.path);
  tree.setStatus(buildState(project.id)); tree.setFilter($('file-filter').value);
}
async function choose(file) {
  if (busy) return;
  const wanted = file.path, owner = project.id;
  active = file; clearOutput(); view('source'); controls(); fileState();
  $('source-name').textContent = file.path;
  if (owner === 'example') {$('source-code').value = editedExample; paintSource(); return;}
  $('inspector-status').textContent = 'Loading selected source file…';
  try {
    const url=new URL(file.blob?.url||file.url,document.baseURI).href;
    if(!sourceCache.has(url))sourceCache.set(url,fetchBytes(url));
    const block=await sourceCache.get(url);
    const bytes=file.blob?block.subarray(file.blob.offset,file.blob.offset+file.blob.size):block;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== (file.blob?.sha256||file.sha256)) throw Error('Source file hash mismatch');
    if (project.id !== owner || active.path !== wanted) return;
    $('source-code').value = new TextDecoder().decode(bytes); paintSource();
    $('inspector-status').textContent = file.blob?.truncated ? `Source preview: first 120 KB of ${(file.blob.sourceBytes/1048576).toFixed(1)} MiB. Compilation uses the complete file.` : 'Verified project source. Build the project, or compile this file to inspect its LowIR and generated code.';
    window.lastProjectEvent = {kind: 'source', project: owner, path: wanted};
  } catch (error) {$('inspector-status').textContent = String(error); window.lastProjectEvent = {kind: 'error', error: String(error)};}
}
function selectProject(id) {
  const next = projects.find(project => project.id === id);
  if (!next || busy) return;
  project = next; $('source-project').value = id; $('file-filter').value = '';
  const x86 = $('inspect-target').querySelector('[value=x86]'); x86.disabled = !['cppgm','example'].includes(id);
  if (x86.disabled) $('inspect-target').value = 'wasm';
  $('tab-generated').textContent = $('inspect-target').value === 'wasm' ? 'WebAssembly' : 'x86 assembly';
  $('inspector-note').textContent = id === 'example'
    ? 'Edit the example, then compile it locally. LowIR is shared by the WebAssembly and x86 targets.'
    : 'Choose a file to see its source and generated code.';
  active = next.files.find(file => file.path === next.buildSources[0]) || next.files[0];
  renderTree(); choose(active);
}
function finish() {busy = false; clearTimeout(deadline); controls();}
function fail(message) {finish(); $('inspector-status').textContent = message; window.lastInspectorEvent = {kind: 'error', error: message};}
function launch() {
  worker = new Worker('./inspector_worker.mjs', {type: 'module'});
  worker.onmessage = ({data}) => {
    if (data.request !== request) return;
    window.lastInspectorEvent = {...data, object: undefined, executable: undefined};
    if (data.kind === 'error') fail(data.error);
    if (data.kind === 'compiled') {
      finish(); result = data;
      outputView('lowir', data.lowir, 'lowir');
      outputView('generated', data.generated, data.target);
      $('tab-generated').textContent = data.target === 'wasm' ? 'WebAssembly' : 'x86 assembly';
      $('inspector-status').textContent = `${data.target === 'wasm' ? 'WebAssembly' : 'x86-64'} · ${data.object.length.toLocaleString()} bytes · ${data.seconds.toFixed(2)} s · compiled locally at -O3`;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([data.object], {type: 'application/octet-stream'}));
      $('object-download').href = url; $('object-download').download = `${active.path.split('/').at(-1)}-${data.target}.o`; $('object-download').hidden = false;
      $('run-example').disabled = !data.executable;
      if (currentTab === 'source') view('generated');
    }
  };
  worker.onerror = event => fail(event.message);
}
$('source-code').addEventListener('input', () => {editedExample = $('source-code').value; paintSource(); clearOutput();});
$('source-code').addEventListener('scroll', () => {
  $('source-highlight').parentElement.scrollTop = $('source-code').scrollTop;
  $('source-highlight').parentElement.scrollLeft = $('source-code').scrollLeft;
});
$('file-filter').oninput = renderTree; $('show-inputs').onchange = renderTree;
$('source-project').onchange = () => selectProject($('source-project').value);
$('inspect-target').onchange = () => {
  clearOutput(); $('tab-generated').textContent = $('inspect-target').value === 'wasm' ? 'WebAssembly' : 'x86 assembly';
  $('inspector-status').textContent = 'Target changed. Compile again to update the outputs.';
};
$('compile-example').onclick = () => {
  if (busy || !canCompile()) return;
  worker ??= (launch(), worker); request++;
  busy = true; controls(); clearOutput(); $('inspector-status').textContent = 'Loading the compiler and compiling this file locally…';
  window.lastInspectorEvent = {kind: 'compiling'};
  deadline = setTimeout(() => {worker.terminate(); worker = null; fail('Compile deadline exceeded. You can try another file.');}, 180000);
  worker.postMessage({kind: 'compile', request, project: project.id, path: active.path,
    source: project.id === 'example' ? $('source-code').value : undefined, target: $('inspect-target').value});
};
$('inspect-cancel').onclick = () => {worker?.terminate(); worker = null; request++; fail('Cancelled. Choose a file or compile again.');};
$('run-example').onclick = async () => {
  if (!result?.executable) return;
  $('run-example').disabled = true;
  const runnerURL = URL.createObjectURL(new Blob([`onmessage=async({data})=>{try{const {instance}=await WebAssembly.instantiate(data,{});postMessage(String(instance.exports.answer(10)));}catch(e){postMessage(String(e));}};`], {type:'text/javascript'}));
  const runner = new Worker(runnerURL);
  const timeout = setTimeout(() => {runner.terminate(); URL.revokeObjectURL(runnerURL); $('inspector-status').textContent = 'Example exceeded its 2-second execution limit.'; $('run-example').disabled = false;}, 2000);
  runner.onmessage = ({data}) => {clearTimeout(timeout); runner.terminate(); URL.revokeObjectURL(runnerURL); $('inspector-status').textContent = `answer(10) → ${data}`; $('run-example').disabled = false; window.lastInspectorRun = data;};
  runner.postMessage(result.executable);
};
window.addEventListener('project-select', ({detail}) => {
  if (busy && project?.id !== detail.project) {worker?.terminate(); worker = null; request++; finish();}
  selectProject(detail.project);
});
window.addEventListener('project-source-select', ({detail}) => {
  selectProject(detail.project);
  const file = project?.files.find(file => file.path === detail.path);
  if (file) {tree.select(file.path); choose(file);}
});
window.addEventListener('project-build', ({detail}) => {
  let rows = buildState(detail.project);
  if (detail.kind === 'reset' || (detail.stage && generations.get(detail.project) !== detail.stage)) {
    rows = new Map(); builds.set(detail.project, rows); generations.set(detail.project, detail.stage);
  }
  if (detail.name && ['progress', 'unit'].includes(detail.kind)) rows.set(detail.name, {
    state: detail.kind === 'progress' ? 'running' : detail.matched ? 'matched' : 'built', seconds: detail.seconds});
  if (['error', 'cancel'].includes(detail.kind)) for (const [name, row] of rows)
    if (row.state === 'running') rows.set(name, {state: detail.kind === 'error' ? 'failed' : 'waiting'});
  if (project?.id === detail.project) {tree.setStatus(rows); fileState();}
});
$('explorer').querySelector('.project-files').open = true;
try {
  const path = document.querySelector('meta[name=project-index]').content;
  const response = await fetch(path); if (!response.ok) throw Error('Project index download failed');
  const index = await response.json(); if (index.schema !== 1) throw Error('Unknown project index');
  for (const project of index.projects) {
    if (!$('source-project').querySelector(`[value="${project.id}"]`)) {
      const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; $('source-project').append(option);
    }
  }
  projects = [...index.projects, {id:'example',name:'Editable example',root:'',buildSources:[],files:[{path:'example.cpp'}]}];
  window.dispatchEvent(new CustomEvent('project-index-ready', {detail: {projects: index.projects}}));
  selectProject(window.activeJourney === 'roundtrip' ? 'llvm' : window.activeJourney === 'inception' ? 'cppgm' : window.activeBuildTarget||'doom');
  window.lastInspectorEvent = {kind:'ready'};
} catch (error) {fail(String(error));}
