import {relativePath} from './plans.mjs';

export const workspace = '/tmp/incpption/checkout';
export const sourceDateEpoch = '1735689600';
const encoder = new TextEncoder();

export function captureWorkflow(actions, exists, wasi = true) {
  if (!actions.length || actions.length > 10000) throw Error('Unexpected number of recorded build commands.');
  const steps = {}, outputs = {}, producers = new Map();
  let products = 0;
  for (const {command, cwd, args, output, inputs} of actions) {
    if (!output.startsWith(workspace + '/') || producers.has(output))
      throw Error('Invalid or repeated build output: ' + output);
    const glob = relativePath(output.slice(workspace.length + 1));
    const step = 'action' + producers.size;
    const inputRefs = {snapshot:'snapshot'};
    const toolInputs = {snapshot:{type:'Directory', loadListing:'shallow_listing'}};
    const listing = ['$(inputs.snapshot.listing)'];
    for (const path of new Set(inputs)) {
      const reference = producers.get(path);
      if (!reference) throw Error('Build command depends on an unrecorded output: ' + path);
      const name = 'in' + Object.keys(inputRefs).length;
      inputRefs[name] = reference;
      toolInputs[name] = 'File';
      listing.push({entry:'$(inputs.' + name + ')', entryname:path.slice(workspace.length + 1)});
    }
    steps[step] = {in:inputRefs, out:['file'], run:{
      class:'CommandLineTool', baseCommand:'env', arguments:['--chdir=' + cwd, '--', command, ...args],
      requirements:{
        InitialWorkDirRequirement:{listing},
        DockerRequirement:{dockerImageId:wasi ? 'willitwasm-wasi' : 'incpption-browser-x86_64-musl', dockerOutputDirectory:workspace},
        EnvVarRequirement:{envDef:{SOURCE_DATE_EPOCH:sourceDateEpoch}},
      },
      inputs:toolInputs, outputs:{file:{type:'File', outputBinding:{glob}}},
    }};
    const ref = step + '/file';
    producers.set(output, ref);
    if (command !== 'cppgm' && exists(output))
      outputs['product' + products++] = {type:'File', outputSource:ref};
  }
  if (!products) throw Error('The build produced no recorded archive or executable.');
  return {cwlVersion:'v1.2', class:'Workflow', label:'checkout', inputs:{snapshot:'Directory'}, outputs, steps};
}

export function packWorkspace(files) {
  const rows = [];
  let size = 0;
  for (const [path, bytes] of files) {
    rows.push({path:relativePath(path), offset:size, size:bytes.length});
    size += bytes.length;
    if (size > 96 * 1024 * 1024 || rows.length > 100000) throw Error('The configured workspace is too large.');
  }
  const index = encoder.encode(JSON.stringify(rows));
  if (index.length > 12 * 1024 * 1024) throw Error('The workspace index is too large.');
  const snapshot = new Uint8Array(4 + index.length + size);
  new DataView(snapshot.buffer).setUint32(0, index.length, true);
  snapshot.set(index, 4);
  let offset = 4 + index.length;
  for (const bytes of files.values()) {
    snapshot.set(bytes, offset);
    offset += bytes.length;
  }
  return snapshot;
}
