import Prism from './vendor/prism.mjs';
import {demoCopy} from './demo_copy.mjs';
const $ = id => document.getElementById(id), copy = demoCopy.inspector;
const example = `// Edit this example, then compile for either target.\nextern "C" int answer(int n) {\n    int total = 0;\n    for (int i = 0; i < n; ++i)\n        total += i * i;\n    return total;\n}\n`;
let worker, files = [], active = 'example.cpp', result, url, busy = false, deadline;
let editedExample = example;
function clearOutput() {
  result = null; $('run-example').disabled = true; $('object-download').hidden = true;
  $('lowir-code').textContent = ''; $('generated-code').textContent = '';
}
function highlight() {
  $('source-highlight').innerHTML = Prism.highlight($('source-code').value + '\n', Prism.languages.cpp, 'cpp');
}
function source(value, readonly) {
  $('source-code').value = value; $('source-code').readOnly = readonly;
  $('source-name').textContent = active;
  $('compile-example').disabled = readonly || busy;
  $('inspector-note').textContent = readonly ? copy.headerNote : copy.explanation;
  highlight();
}
function renderFiles() {
  $('source-files').replaceChildren();
  const filtered = ['example.cpp', ...files].filter(path => path.toLowerCase().includes($('file-filter').value.toLowerCase()));
  for (const path of filtered.slice(0, 150)) {
    const button = document.createElement('button'); button.textContent = path;
    button.title = path; button.setAttribute('aria-pressed', String(active === path));
    button.onclick = () => {
      if (busy) return;
      active = path; clearOutput(); renderFiles();
      if (path === 'example.cpp') source(editedExample, false);
      else {worker.postMessage({kind: 'read', path}); $('inspector-status').textContent = copy.loadingFile;}
    };
    $('source-files').append(button);
  }
  $('file-count').textContent = `${filtered.length} files${filtered.length > 150 ? ' · refine search to see more' : ''}`;
}
function finish() {
  busy = false; clearTimeout(deadline);
  $('inspect-target').disabled = false; $('source-code').readOnly = active !== 'example.cpp';
  $('compile-example').disabled = active !== 'example.cpp'; $('inspect-cancel').disabled = true;
}
function fail(message) {
  finish(); $('inspector-status').textContent = message;
  window.lastInspectorEvent = {kind: 'error', error: message};
}
function launch() {
  worker = new Worker('./inspector_worker.mjs', {type: 'module'});
  worker.onmessage = ({data}) => {
    window.lastInspectorEvent = {...data, object: undefined, executable: undefined};
    if (data.kind === 'ready') {
      files = data.files; finish(); renderFiles(); source(editedExample, false);
      $('inspector-status').textContent = 'Ready. Choose a target and compile the example.';
    }
    if (data.kind === 'source' && active === data.path) {source(data.text, true); $('inspector-status').textContent = 'Frozen compiler source · read only';}
    if (data.kind === 'error') fail(data.error);
    if (data.kind === 'compiled') {
      finish(); result = data;
      $('lowir-code').textContent = data.lowir; $('generated-code').textContent = data.generated;
      $('generated-title').textContent = data.target === 'wasm' ? 'WebAssembly · WAT' : 'x86-64 · Intel syntax';
      $('inspector-status').textContent = `${data.target === 'wasm' ? 'WebAssembly' : 'x86-64'} · ${data.object.length.toLocaleString()} bytes · ${data.seconds.toFixed(2)} s · object and LowIR view compiled locally at -O3${data.executionDiagnostic ? ' · Run requires a standalone exported answer function.' : ''}`;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([data.object], {type: 'application/octet-stream'}));
      $('object-download').href = url; $('object-download').download = `example-${data.target}.o`; $('object-download').hidden = false;
      $('run-example').disabled = !data.executable;
    }
  };
  worker.onerror = event => fail(event.message);
  worker.postMessage({kind: 'load'});
}
let loaded = false;
$('explorer').addEventListener('toggle', () => {
  if (!$('explorer').open || loaded) return;
  loaded = true; busy = true; $('inspector-status').textContent = copy.loadingFiles; launch();
});
$('source-code').addEventListener('input', () => {
  editedExample = $('source-code').value; highlight(); clearOutput();
});
$('source-code').addEventListener('scroll', () => {
  $('source-highlight').parentElement.scrollTop = $('source-code').scrollTop;
  $('source-highlight').parentElement.scrollLeft = $('source-code').scrollLeft;
});
$('file-filter').oninput = renderFiles;
$('inspect-target').onchange = () => {
  clearOutput();
  $('inspector-status').textContent = 'Target changed. Compile again to update the outputs.';
};
$('compile-example').onclick = () => {
  if (busy || active !== 'example.cpp') return;
  busy = true; $('compile-example').disabled = true; $('run-example').disabled = true;
  $('inspect-target').disabled = true; $('source-code').readOnly = true;
  $('inspect-cancel').disabled = false; $('object-download').hidden = true;
  $('lowir-code').textContent = ''; $('generated-code').textContent = '';
  $('inspector-status').textContent = copy.compiling;
  window.lastInspectorEvent = {kind: 'compiling'};
  deadline = setTimeout(() => {worker.terminate(); worker = null; loaded = false; fail('Compile deadline exceeded. Close and reopen the explorer to retry.');}, 90000);
  worker.postMessage({kind: 'compile', source: $('source-code').value, target: $('inspect-target').value, run: $('inspect-target').value === 'wasm'});
};
$('inspect-cancel').onclick = () => {
  worker?.terminate(); worker = null; loaded = false; fail('Cancelled. Close and reopen the explorer to start again.');
  $('compile-example').disabled = true;
};
$('run-example').onclick = async () => {
  if (!result?.executable) return;
  $('run-example').disabled = true;
  // Run visitor code in a disposable worker so an endless loop cannot freeze
  // the UI. The target's agreed entry is int answer(int), called with 10.
  const code = `onmessage=async({data})=>{try{const {instance}=await WebAssembly.instantiate(data,{});postMessage(String(instance.exports.answer(10)));}catch(e){postMessage(String(e));}};`;
  const runnerURL = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
  const runner = new Worker(runnerURL);
  const timeout = setTimeout(() => {runner.terminate(); URL.revokeObjectURL(runnerURL); $('inspector-status').textContent = 'Example exceeded its 2-second execution limit.'; $('run-example').disabled = false;}, 2000);
  runner.onmessage = ({data}) => {
    clearTimeout(timeout); runner.terminate(); URL.revokeObjectURL(runnerURL);
    $('inspector-status').textContent = `answer(10) → ${data}`; $('run-example').disabled = false;
    window.lastInspectorRun = data;
  };
  runner.postMessage(result.executable);
};
