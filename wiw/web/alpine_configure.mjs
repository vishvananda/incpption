import {projectSource} from './configure_source.mjs';
import {tar} from './tar.mjs';
import {compileSeed} from './seed_package.mjs';
import {decodeBytes, fetchBytes, hash} from './transport_bytes.mjs';
import {wasiSdk} from './wasi_sdk.mjs';

const scripts = ['configure.sh', 'capture.py', 'replay.py', 'prepare.py', 'capture-and-export.py'];
const decoder = new TextDecoder();
const text = new TextEncoder();

async function guestModule(signal, log) {
  const prefix = new URL('alpine/', location.href);
  const guest = JSON.parse(decoder.decode(await fetchBytes(new URL('guest.json', prefix), {signal})));
  const cache = await globalThis.caches?.open('willitwasm-alpine-' + guest.sha256).catch(() => null);
  const rows = new Map(guest.chunks.map(row => [new URL(row.path, prefix).href, row]));
  let received = 0;
  return compileSeed(guest, prefix.href, {read: async path => {
    const options = {signal, credentials: 'omit'};
    const row = rows.get(path);
    if (!row) throw Error('Unexpected Alpine chunk URL.');
    const previous = await cache?.match(path);
    let bytes = previous && await decodeBytes(previous).catch(() => null);
    if (!bytes || bytes.length !== row.size || await hash(bytes) !== row.sha256) {
      const response = await fetch(path, options);
      if (!response.ok) throw Error('Could not download an Alpine image chunk.');
      const saved = cache && response.clone();
      bytes = await decodeBytes(response);
      if (bytes.length !== row.size || await hash(bytes) !== row.sha256) throw Error('Alpine chunk checksum differs.');
      if (saved) await cache.put(path, saved).catch(() => {});
    }
    received++;
    if (received % 4 === 0 || received === rows.size) log('Alpine image ' + received + '/' + rows.size + ' chunks ready');
    return bytes;
  }});
}

async function batch(project, {archive, config}) {
  const id = 'checkout';
  const row = {id, version: project.commit, ...config, sha256: await hash(archive)};
  return tar([['batch.json', text.encode(JSON.stringify([row]))], [id + '.tar.gz', archive]]);
}

export async function configure(project, signal, log, target, source) {
  const wasi = target === 'wasm32-wasip1';
  const extra = wasi ? ['wasi_toolchain.cmake','WASI.cmake','wasi-probe.bin'] : [];
  const names = [...scripts, ...extra];
  const [module, input, scriptBytes, profile, sdk] = await Promise.all([
    guestModule(signal, log),
    (source ? Promise.resolve(source) : projectSource(project, signal, log, target)).then(source => batch(project, source)),
    Promise.all(names.map(script => fetchBytes('alpine/' + script, {signal}))),
    fetchBytes('alpine/profile.json', {signal}).then(bytes => JSON.parse(decoder.decode(bytes))),
    wasi ? wasiSdk() : null,
  ]);
  signal.throwIfAborted();
  const files = Object.fromEntries(names.map((name, i) => [name, scriptBytes[i]]));
  files['batch.tar'] = input;
  if (wasi) {
    if (await hash(files['wasi-probe.bin']) !== profile.wasiProbeSha256)
      throw Error('WASI configuration compiler checksum differs.');
    files['wasi-sdk.tar'] = tar(sdk.flatMap(layer => layer.files.map(file =>
      [file.path, layer.bundle.subarray(file.offset, file.offset + file.size)])));
  }
  if (profile.includePaths) files['include-paths.json'] = text.encode(JSON.stringify(profile.includePaths));
  const worker = new Worker(new URL('./configure-worker.mjs', import.meta.url), {type: 'module'});
  try {
    log('Starting Alpine. Configure output will appear here.');
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      worker.onerror = event => reject(Error(event.message));
      worker.onmessageerror = () => reject(Error('Could not read the Alpine worker response.'));
      worker.onmessage = async ({data}) => {
        if (data.kind === 'configure-log') log(data.line);
        if (data.kind === 'error') reject(Error(data.error));
        if (data.kind !== 'configured') return;
        try {
          if (data.sdk.machine !== profile.sdk.machine || data.sdk.gcc !== profile.sdk.gcc)
            throw Error('The Alpine image and build SDK use different versions.');
          if (data.sdk.target !== (wasi ? target : 'x86_64-linux-musl')) throw Error('Unexpected plan target.');
          resolve({schema: 'willitwasm/v1', kind: 'alpine-cwl', ...project, ...(wasi ? {target} : {}),
            workflow: JSON.parse(decoder.decode(data.plan)), snapshot: data.snapshot,
            snapshotSha256: await hash(data.snapshot)});
        } catch (error) {reject(error);}
      };
      worker.postMessage({module, files, project: 'checkout'}, Object.values(files).map(file => file.buffer));
    });
  } finally {
    worker.terminate();
  }
}
