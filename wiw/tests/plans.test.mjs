import assert from 'node:assert/strict';
import test from 'node:test';
import {boundedBytes, discover, planBlob, repoName, unpackPlan, validatePlan} from '../web/plans.mjs';
import {hash} from '../web/transport_bytes.mjs';
import {tar} from '../web/tar.mjs';

const base = 'http://127.0.0.1:8327/';
const repo = 'owner/project';
const commit = '9'.repeat(40);
const project = {repo, commit};
const wasi = {schema:'willitwasm/v1', kind:'wasi', ...project, sources:['src/main.c'], files:['src/main.h']};

test('normalizes public GitHub repository links and rejects other URLs', () => {
  assert.equal(repoName(' https://github.com/XProger/OpenLara.git/ '), 'XProger/OpenLara');
  assert.equal(repoName('owner/project'), repo);
  for (const name of ['https://gitlab.com/owner/project', 'https://github.com/owner/project/tree/main',
    'https://nobody@github.com/owner/project', 'https://github.com/owner/project?ref=main'])
    assert.throws(() => repoName(name));
});

test('a plan must bind to the source revision and stay within its workspace', () => {
  assert.equal(validatePlan(wasi, project), wasi);
  assert.throws(() => validatePlan(wasi, {repo, commit:'a'.repeat(40)}), /Git commit/);
  assert.throws(() => validatePlan({...wasi, sources:['../main.c']}, project), /Invalid plan path/);
  assert.throws(() => validatePlan({...wasi, kind:'shell'}, project), /Unsupported/);
});

test('Emscripten plans pin the SDK, outputs and all build inputs', () => {
  const sha256 = 'a'.repeat(64);
  const layer = {path:'input.bin', bytes:20, sha256, encoding:'gzip'};
  const compilation = [{cwd:'checkout', source:'checkout/game.c', path:'trace/game.o',
    args:['-c', 'game.c', '-o', '/trace/game.o']}];
  const plan = {schema:'willitwasm/v1', kind:'emscripten', ...project, sdk:'4.0.9', epoch:1735689600,
    compilation, archives:{}, link:{cwd:'checkout', args:['-o', '/result/game.wasm'], sha256},
    post:[{tool:'strip-custom', sections:['producers'], sha256}], sha256, entry:'game.html', output:'game.wasm',
    source:layer, libraries:layer, player:layer};
  assert.equal(validatePlan(plan, project), plan);
  assert.throws(() => validatePlan({...plan, sdk:'5.0.0'}, project), /Unsupported Emscripten/);
  assert.throws(() => validatePlan({...plan, player:undefined}, project), /Invalid Emscripten input/);
  assert.throws(() => validatePlan({...plan, source:{...layer, path:'../input.bin'}}, project), /Invalid plan path/);
  assert.throws(() => validatePlan({...plan, compilation:[...compilation, ...compilation]}, project), /Invalid Emscripten compile output/);
  assert.throws(() => validatePlan({...plan, post:[{tool:'node', sha256}]}, project), /Unsupported Emscripten post-link/);
});

test('bundled examples resolve without a GitHub API request', async () => {
  const {plan} = await discover({repo:'XProger/OpenLara', base});
  assert.equal(plan.project, 'lara');
});

test('explicit and publisher plans take precedence over saved registry plans', async () => {
  const registry = base + 'registry.json';
  const explicit = base + 'picked.json';
  const repoURL = 'https://raw.githubusercontent.com/' + repo + '/' + commit + '/.willitwasm/plan.json';
  const original = globalThis.fetch;
  let publisher = true;
  const requests = [];
  globalThis.fetch = async url => {
    const string = String(url);
    requests.push(string);
    if (string === explicit) return Response.json(wasi);
    if (string === repoURL && publisher) return Response.json({...wasi, commit:undefined});
    if (string === repoURL) return new Response(null, {status:404});
    if (string === registry) return Response.json({schema:'willitwasm/v1', plans:{[repo + '@' + commit]:explicit}});
    throw Error('Unexpected fetch ' + string);
  };
  try {
    assert.equal((await discover({repo, ref:commit, explicit, registry, base})).origin, 'Shared link');
    assert.deepEqual(requests.splice(0), [explicit]);
    const checkedIn = await discover({repo, ref:commit, registry, base});
    assert.equal(checkedIn.origin, 'Repository plan');
    assert.equal(checkedIn.plan.commit, commit);
    assert.deepEqual(requests.splice(0), [repoURL]);
    publisher = false;
    assert.equal((await discover({repo, ref:commit, registry, base})).origin, 'Saved plan index');
    assert.deepEqual(requests.splice(0), [repoURL, registry, explicit]);
  } finally {globalThis.fetch = original;}
});

test('Alpine plan files round trip and detect workspace corruption', async () => {
  const snapshot = Uint8Array.of(1,2,3);
  const plan = {schema:'willitwasm/v1', kind:'alpine-cwl', ...project,
    workflow:{cwlVersion:'v1.2', class:'Workflow', steps:{}, outputs:{}}, snapshot,
    snapshotSha256:await hash(snapshot)};
  const file = new Uint8Array(await planBlob(plan).arrayBuffer());
  assert.deepEqual((await unpackPlan(file, project)).snapshot, snapshot);
  file[file.length - 1] ^= 1;
  await assert.rejects(unpackPlan(file, project), /checksum/);
});

test('downloads enforce limits for chunked responses', async () => {
  await assert.rejects(boundedBytes(new Response(new Uint8Array(32)), 16), /allowed size/);
});

test('guest batch packs the header and pads the next file correctly', () => {
  const archive = tar([['batch.json', Uint8Array.of(4)], ['checkout.tar.gz', Uint8Array.of(5,6)]]);
  const decoder = new TextDecoder();
  assert.equal(decoder.decode(archive.subarray(0,10)), 'batch.json');
  assert.equal(decoder.decode(archive.subarray(1024,1039)), 'checkout.tar.gz');
  assert.deepEqual([...archive.subarray(1536,1538)], [5,6]);
  assert.equal(archive.length, 3072);
});
