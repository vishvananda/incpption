import {presetRecipe} from './presets.mjs';
import {getPlan} from './storage.mjs';
import {hash} from './transport_bytes.mjs';

export const examples = [
  {id: 'lara', repo: 'XProger/OpenLara', title: 'OpenLara', detail: 'Tomb Raider engine'},
  {id: 'doom', repo: 'gabrielcuvillier/d3wasm', title: 'Doom 3', detail: 'Web port'},
  {id: 'godot', repo: 'godotengine/godot', title: 'Godot editor', detail: 'Long build'},
];
const decoder = new TextDecoder();
const format = 'willitwasm/v1';
const maxPlan = 128 * 1024 * 1024;
const maxEmscriptenLayer = 512 * 1024 * 1024;
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function repoName(input) {
  const value = input.trim();
  const url = new URL(value.includes('://') ? value : 'https://github.com/' + value);
  const name = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/i, '');
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash ||
      !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(name) || ['.', '..'].includes(name.split('/')[1]))
    throw Error('Enter a GitHub repository URL or owner/repo.');
  return name;
}

export function relativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\x00-\x1f?#]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..'))
    throw Error('Invalid plan path: ' + value);
  return value;
}

export function publicURL(value, base) {
  const url = new URL(value, base);
  if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw Error('Plan URLs must use HTTPS.');
  return url;
}

export const planKey = ({repo, commit}) => repo.toLowerCase() + '@' + commit;
export const rawFile = ({repo, commit}, path) =>
  'https://raw.githubusercontent.com/' + repo + '/' + commit + '/' +
  relativePath(path).split('/').map(encodeURIComponent).join('/');

export async function remote(url, signal, {optional = false} = {}) {
  const result = await fetch(url, {credentials: 'omit', signal});
  if (result.status === 404 && optional) return null;
  if (!result.ok) throw Error(new URL(url, location.href).hostname + ' returned HTTP ' + result.status);
  return result;
}

export async function boundedBytes(response, limit = maxPlan) {
  if (Number(response.headers.get('Content-Length')) > limit) throw Error('Download exceeds the allowed size.');
  const reader = response.body.getReader(), chunks = [];
  let count = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      count += value.length;
      if (count > limit) throw Error('Download exceeds the allowed size.');
      chunks.push(value);
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function json(url, signal, optional = false) {
  const response = await remote(url, signal, {optional});
  return response && JSON.parse(decoder.decode(await boundedBytes(response, 4 * 1024 * 1024)));
}

function flags(value = []) {
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')))
    throw Error('Build flags must be strings.');
  return value;
}

export function sourcePaths(plan) {
  const sources = new Set(plan.sources);
  return [...plan.sources, ...(plan.files ?? []), ...Object.keys(plan.generated ?? {}).filter(path => !sources.has(path))];
}

export function validatePlan(plan, expected) {
  if (plan?.schema !== format || repoName(plan.repo).toLowerCase() !== expected.repo.toLowerCase())
    throw Error('The build plan does not identify this repository.');
  if (plan.kind === 'example') {
    const example = examples.find(row => row.id === plan.project && row.repo.toLowerCase() === expected.repo.toLowerCase());
    if (!example || expected.commit) throw Error('This example uses a frozen source package.');
    return plan;
  }
  if (!isSha(plan.commit) || (expected.commit && expected.commit !== plan.commit))
    throw Error('The build plan must match the selected Git commit.');
  if (plan.kind === 'wasi' || plan.kind === 'macho') {
    if (!Array.isArray(plan.sources) || !plan.sources.length || !Array.isArray(plan.files ?? []))
      throw Error('A source build plan needs a source list.');
    const generated = plan.generated ?? {};
    if (typeof generated !== 'object' || !generated || Array.isArray(generated) ||
        Object.values(generated).some(text => typeof text !== 'string' || text.length > 1024 * 1024))
      throw Error('Generated inputs must be text files of at most 1 MiB.');
    const names = sourcePaths(plan).map(relativePath);
    if (names.length > 6000 || new Set(names).size !== names.length) throw Error('Invalid or duplicate source paths.');
    flags(plan.compileFlags);
    flags(plan.linkFlags);
    if (plan.kind === 'wasi') {
      const output = relativePath(plan.output ?? 'program.wasm');
      if (!output.endsWith('.wasm')) throw Error('The WASI output must end in .wasm.');
    } else if (typeof plan.output !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(plan.output) ||
        !Array.isArray(plan.libSystem) || plan.libSystem.length > 2000 ||
        plan.libSystem.some(symbol => typeof symbol !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(symbol))) {
      throw Error('A Mach-O plan needs an executable name and libSystem import names.');
    }
  } else if (plan.kind === 'emscripten') {
    const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const commands = plan.compilation;
    if (plan.sdk !== '4.0.9' || !Number.isSafeInteger(plan.epoch) ||
        !Array.isArray(commands) || !commands.length || commands.length > 10000 ||
        typeof plan.archives !== 'object' || !plan.archives || Array.isArray(plan.archives) ||
        Object.keys(plan.archives).length > 1000 || !Array.isArray(plan.post) || plan.post.length > 16 ||
        !checksum(plan.link?.sha256) || !checksum(plan.sha256))
      throw Error('Unsupported Emscripten build plan.');
    const outputs = new Set();
    for (const row of commands) {
      const output = relativePath(row.path);
      relativePath(row.cwd);
      relativePath(row.source);
      if (outputs.has(output) || flags(row.args).at(-2) !== '-o' || row.args.at(-1) !== '/' + output)
        throw Error('Invalid Emscripten compile output.');
      outputs.add(output);
    }
    for (const [path, members] of Object.entries(plan.archives)) {
      if (outputs.has(relativePath(path)) || !Array.isArray(members) || !members.length)
        throw Error('Invalid Emscripten archive.');
      members.forEach(relativePath);
    }
    for (const row of plan.post) {
      if (!['wasm-opt', 'wasm-metadce', 'wasm-emscripten-finalize', 'strip-custom'].includes(row.tool) || !checksum(row.sha256))
        throw Error('Unsupported Emscripten post-link command.');
      if (row.tool === 'strip-custom' && (!Array.isArray(row.sections) || !row.sections.length || row.sections.length > 64 ||
          row.sections.some(name => typeof name !== 'string' || name.length > 128)))
        throw Error('Invalid custom section list.');
      flags(row.args);
    }
    relativePath(plan.link.cwd);
    flags(plan.link.args);
    if (!/^[\w.-]+\.html$/.test(plan.entry) || !/^[\w.-]+\.wasm$/.test(plan.output))
      throw Error('The Emscripten plan needs HTML and Wasm output names.');
    for (const file of [plan.source, plan.libraries, plan.player, ...(plan.sdkInputs ? [plan.sdkInputs] : [])]) {
      if (!checksum(file?.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 4 || file.bytes > maxEmscriptenLayer ||
          (file.encoding !== undefined && file.encoding !== 'gzip'))
        throw Error('Invalid Emscripten input bundle.');
      relativePath(file.path);
    }
  } else if (plan.kind === 'alpine-cwl') {
    if (plan.target !== undefined && plan.target !== 'wasm32-wasip1') throw Error('Unsupported Alpine plan target.');
    if (!/^[a-f0-9]{64}$/.test(plan.snapshotSha256 ?? '') ||
        (!plan.workflow && typeof plan.workflowURL !== 'string'))
      throw Error('An Alpine plan needs a workflow and a hashed workspace snapshot.');
  } else throw Error('Unsupported build plan type.');
  return plan;
}

export async function unpackPlan(bytes, expected) {
  if (bytes.length < 8 || bytes.length > maxPlan) throw Error('Invalid build plan bundle size.');
  const size = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (!size || size > Math.min(4 * 1024 * 1024, bytes.length - 4)) throw Error('Invalid build plan bundle header.');
  const plan = validatePlan(JSON.parse(decoder.decode(bytes.subarray(4, 4 + size))), expected);
  if (plan.kind !== 'alpine-cwl') throw Error('A binary plan bundle must contain an Alpine workspace.');
  const snapshot = bytes.subarray(4 + size);
  if (await hash(snapshot) !== plan.snapshotSha256) throw Error('The workspace snapshot checksum differs.');
  return {...plan, snapshot};
}

export function planBlob({snapshot, ...header}) {
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return new Blob([length, bytes, snapshot], {type: 'application/octet-stream'});
}

export async function loadPlan(url, expected, signal, optional = false) {
  const response = await remote(url, signal, {optional});
  if (!response) return null;
  const base = response.url || String(url);
  const bytes = await boundedBytes(response);
  if (new URL(base).pathname.endsWith('.wwplan')) return unpackPlan(bytes, expected);
  const parsed = JSON.parse(decoder.decode(bytes));
  // A manifest checked into the commit cannot include its own commit ID.
  if (parsed && !parsed.commit && base === rawFile(expected, '.willitwasm/plan.json') && parsed.kind !== 'example')
    parsed.commit = expected.commit;
  const plan = validatePlan(parsed, expected);
  if (plan.kind === 'emscripten') return {...plan, baseURL:base};
  if (plan.kind !== 'alpine-cwl') return plan;
  const workflow = plan.workflow ?? await json(publicURL(plan.workflowURL, base), signal);
  if (typeof plan.snapshotURL !== 'string') throw Error('The Alpine plan must include a workspace URL.');
  const snapshot = await boundedBytes(await remote(publicURL(plan.snapshotURL, base), signal));
  if (await hash(snapshot) !== plan.snapshotSha256) throw Error('The workspace snapshot checksum differs.');
  return {...plan, workflow, snapshot, workflowURL: undefined, snapshotURL: undefined};
}

export async function discover({repo, ref, explicit, registry, signal, base}) {
  const project = {repo, commit: isSha(ref) ? ref : null};
  if (explicit) {
    if (ref && !project.commit) project.commit = await resolveCommit(repo, ref, signal);
    const plan = await loadPlan(publicURL(explicit, base), project, signal);
    return {project: {...project, commit: plan.commit ?? project.commit}, plan, origin: 'Shared link'};
  }
  const example = !ref && examples.find(row => row.repo.toLowerCase() === repo.toLowerCase());
  if (example) return {project, plan: {schema: format, kind: 'example', repo, project: example.id}, origin: 'incpption plan'};
  project.commit ??= await resolveCommit(repo, ref || 'HEAD', signal);
  const published = await loadPlan(rawFile(project, '.willitwasm/plan.json'), project, signal, true);
  if (published) return {project, plan: published, origin: 'Repository plan'};
  const saved = await getPlan(planKey(project)).catch(() => null);
  if (saved) return {project, plan: validatePlan(saved, project), origin: 'Saved in this browser'};
  if (registry) {
    const indexURL = publicURL(registry, base);
    const index = await json(indexURL, signal);
    if (index?.schema !== format || !index.plans) throw Error('Invalid saved plan index.');
    const url = index.plans[planKey(project)];
    if (url) return {project, plan: await loadPlan(publicURL(url, indexURL), project, signal), origin: 'Saved plan index'};
  }
  return {project, plan: null, origin: ''};
}

async function resolveCommit(repo, ref, signal) {
  const result = await json('https://api.github.com/repos/' + repo + '/commits/' + encodeURIComponent(ref), signal);
  if (!isSha(result?.sha)) throw Error('GitHub returned no commit for this ref.');
  return result.sha;
}

export async function recipe(project, signal, target) {
  const file = await json(rawFile(project, '.willitwasm/configure.json'), signal, true);
  if (!file) return presetRecipe(project, target);
  if (!['auto', 'configure', 'cmake', 'meson', 'make', 'python'].includes(file.system))
    throw Error('Unsupported build system in .willitwasm/configure.json.');
  const result = {system: file.system, options: flags(file.options)};
  if (file.sourceDirectory) result.sourceDirectory = relativePath(file.sourceDirectory);
  if (file.target) {
    if (typeof file.target !== 'string' || file.target.startsWith('-')) throw Error('Invalid build target.');
    result.target = file.target;
  }
  return result;
}
