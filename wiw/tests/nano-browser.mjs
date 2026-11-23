import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {unpackPlan} from '../web/plans.mjs';
import {tar} from '../web/tar.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
const repo = 'madler/zlib';

async function open(failNano = false, fixture = false) {
  const page = await browser.newPage({acceptDownloads:true});
  const requests = [], errors = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.WILLITWASM_TRACE) {
    page.on('requestfailed', request => console.log(request.failure()?.errorText, new URL(request.url()).pathname));
    await page.exposeFunction('wwTrace', line => console.log(line));
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const output = document.getElementById('console');
      if (output) new MutationObserver(() => globalThis.wwTrace(output.textContent.trim().split('\n').at(-1)))
        .observe(output, {childList:true, subtree:true, characterData:true});
    }));
  }
  if (failNano) await page.route('**/nano/**/runtime.bin', route => route.abort());
  if (fixture) {
    await page.goto(await makeFixture(page, fixture));
    await page.getByText(/No build plan found/).waitFor();
  } else {
    await page.goto(base);
    await page.waitForFunction(repo => document.querySelector(`#examples option[value="https://github.com/${repo}"]`), repo);
    await page.locator('#repo').fill('https://github.com/' + repo);
  }
  const build = page.getByRole('button', {name:'Build', exact:true});
  await build.click();
  const dialog = page.locator('#alpine-dialog');
  await dialog.getByRole('button', {name:'Start NanoVM', exact:true}).waitFor();
  const nano = () => requests.filter(path => /\/nano\//.test(path)).length;
  const alpine = () => requests.filter(path => /\/alpine\/(?:guest\.|wasi-probe\.bin)/.test(path)).length;
  const wanix = () => requests.filter(path => /\/wanix\//.test(path)).length;
  const archives = () => requests.filter(path => path.endsWith('/api/archive')).length;
  assert.equal(nano(), 0, 'NanoVM waits for approval');
  assert.equal(wanix(), 0, 'Wanix waits for approval');
  assert.equal(alpine(), 0, 'Alpine waits for approval');
  return {page, dialog, build, nano, wanix, alpine, archives, errors};
}

async function finished(page, guest = 'NanoVM') {
  await page.waitForFunction(guest => {
    const status = document.querySelector('#plan-status').textContent;
    return /^(Build complete|Build failed|Plan generation failed)/.test(status) ||
      status.startsWith(guest + ' could not');
  }, guest, {timeout:900000});
  const status = await page.locator('#plan-status').innerText();
  if (!status.startsWith('Build complete')) await page.waitForTimeout(150);
  assert.match(status, /^Build complete/, await page.locator('#console').innerText());
}

async function bytesFrom(page, button) {
  const download = page.waitForEvent('download');
  await button.click();
  return readFile(await (await download).path());
}

async function makeFixture(page, target, direct = false) {
  const source = 'test/hello-make', commit = 'a'.repeat(40);
  const files = Object.entries({
    Makefile: 'hello: ' + (direct ? 'main.c' : 'main.o') + ' libhello.a\n' +
      '\t@test ! -e "/#js" && test ! -e "/#httpfs" && test ! -e "/#idbfs" && test ! -e "/#web"\n' +
      '\t$(CC) ' + (direct ? 'main.c' : 'main.o') + ' -L. -lhello -o $@\n' +
      'libhello.a: value.o\n\t$(AR) rc $@ $^\n',
    'main.c': 'int value(void); int main(void) { return value() != 42; }\n',
    'value.c': 'int value(void) { return 42; }\n',
  }).map(([name, text]) => ['hello-make/' + name, new TextEncoder().encode(text)]);
  await page.route('https://raw.githubusercontent.com/' + source + '/' + commit + '/**', route => {
    const headers = {'access-control-allow-origin':'*'};
    return target && route.request().url().endsWith('configure.json') ?
      route.fulfill({status:200, headers, json:{system:'make', target}}) : route.fulfill({status:404, headers});
  });
  await page.route('**/api/archive?**', route => route.fulfill({status:200, body:gzipSync(tar(files))}));
  const url = new URL(base);
  url.search = new URLSearchParams({repo:'https://github.com/' + source, ref:commit});
  return url.href;
}

async function makeLink() {
  const page = await browser.newPage({acceptDownloads:true});
  await page.goto(await makeFixture(page));
  await page.getByText(/No build plan found/).waitFor();
  await page.getByRole('button', {name:'Build', exact:true}).click();
  await page.getByRole('button', {name:'Start NanoVM', exact:true}).click();
  await finished(page);
  assert.ok(WebAssembly.validate(await bytesFrom(page, page.getByRole('link', {name:'Download hello.wasm'}))));
  await page.close();
  console.log('NanoVM captured a plain Make build and linked its recorded archive');
}

async function nanoBuilds() {
  const run = await open();
  await run.dialog.getByRole('button', {name:'Start NanoVM', exact:true}).click();
  await finished(run.page);
  assert.ok(run.nano() > 0);
  assert.equal(run.wanix(), 0, 'successful NanoVM plans never fetch Wanix');
  assert.equal(run.alpine(), 0, 'successful NanoVM plans never fetch Alpine');
  const archiveLink = run.page.getByRole('link', {name:'Download libz.a'});
  const archive = await bytesFrom(run.page, archiveLink);
  assert.equal(archive.subarray(0, 8).toString(), '!<arch>\n');
  const saved = await unpackPlan(await bytesFrom(run.page, run.page.locator('#download-plan')), {repo});
  assert.equal(saved.target, 'wasm32-wasip1');
  assert.ok(Object.keys(saved.workflow.steps).length > 10);

  const requests = run.nano();
  await run.page.reload();
  await run.page.getByText(/Saved in this browser/).waitFor();
  await run.build.click();
  await finished(run.page);
  assert.deepEqual(await bytesFrom(run.page, archiveLink), archive);
  assert.equal(run.nano(), requests, 'cached plans replay without starting NanoVM');
  assert.equal(run.alpine(), 0);
  assert.deepEqual(run.errors, []);
  await run.page.close();
  console.log('NanoVM generated, saved and replayed the zlib plan without downloading Alpine');

  await makeLink();

  return archive;
}

async function wanixBuild(archive) {
  const run = await open(true);
  await run.dialog.getByRole('button', {name:'Start NanoVM', exact:true}).click();
  const fallback = run.dialog.getByRole('button', {name:'Start Wanix Linux', exact:true});
  await fallback.waitFor();
  assert.equal(run.wanix(), 0, 'NanoVM failure offers Wanix before downloading it');
  assert.equal(run.alpine(), 0, 'Alpine waits for its own approval');
  const started = Date.now();
  await fallback.click();
  await finished(run.page, 'Wanix Linux');
  assert.ok(run.wanix() > 0);
  assert.equal(run.alpine(), 0);
  assert.equal(run.archives(), 1, 'Wanix reuses the source archive');
  const link = run.page.getByRole('link', {name:'Download libz.a'});
  const bytes = await bytesFrom(run.page, link);
  assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n');
  if (archive) assert.deepEqual(bytes, archive, 'Wanix and NanoVM produce identical zlib archives');
  const saved = await unpackPlan(await bytesFrom(run.page, run.page.locator('#download-plan')), {repo});
  assert.equal(saved.target, 'wasm32-wasip1');
  assert.ok(Object.keys(saved.workflow.steps).length > 10);
  const requests = run.wanix();
  console.log('Wanix generated and built the zlib plan in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  await run.page.reload();
  await run.page.getByText(/Saved in this browser/).waitFor();
  await run.build.click();
  await finished(run.page);
  assert.deepEqual(await bytesFrom(run.page, link), bytes);
  assert.equal(run.wanix(), requests, 'cached plans replay without starting Wanix');
  assert.deepEqual(run.errors, []);
  await run.page.close();
}

async function wanixMakeLink() {
  const run = await open(true, 'hello');
  await run.dialog.getByRole('button', {name:'Start NanoVM', exact:true}).click();
  await run.dialog.getByRole('button', {name:'Start Wanix Linux', exact:true}).click();
  await finished(run.page, 'Wanix Linux');
  const bytes = await bytesFrom(run.page, run.page.getByRole('link', {name:'Download hello.wasm'}));
  assert.ok(WebAssembly.validate(bytes));
  assert.equal(run.archives(), 1);
  assert.equal(run.alpine(), 0);
  assert.deepEqual(run.errors, []);
  await run.page.close();
  console.log('Wanix captured a plain Make build and linked its recorded archive');
}

async function wanixNativeLink() {
  const page = await browser.newPage({acceptDownloads:true});
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.goto(await makeFixture(page, 'hello', true));
  await page.getByText(/No build plan found/).waitFor();
  await page.getByRole('button', {name:'Build', exact:true}).click();
  await page.locator('#plan-target').selectOption('x86_64-linux-musl');
  const start = page.getByRole('button', {name:'Start Wanix Linux', exact:true});
  await start.waitFor();
  assert.ok(!requests.some(path => path.includes('/wanix/')));
  await start.click();
  await finished(page, 'Wanix Linux');
  assert.ok(!requests.some(path => /\/alpine\/guest\./.test(path)));
  const binary = await bytesFrom(page, page.getByRole('link', {name:'Download hello', exact:true}));
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(binary[4], 2, 'ELF64');
  assert.equal(binary.readUInt16LE(18), 62, 'x86-64');
  const plan = await unpackPlan(await bytesFrom(page, page.locator('#download-plan')), {repo:'test/hello-make'});
  assert.equal(plan.target, undefined, 'Linux native plan');
  assert.ok(Object.values(plan.workflow.steps).some(step => step.run.arguments[2] === 'ld.lld'));
  await page.close();
  console.log('Wanix captured an x86-64 executable and linked the recorded archive');
}

async function alpineFallback(wanix) {
  const retry = await open(true, 'libhello.a');
  if (wanix) await retry.page.route('**/wanix/**/kernel.bin', route => route.abort());
  await retry.dialog.getByRole('button', {name:'Start NanoVM', exact:true}).click();
  if (wanix) {
    await retry.dialog.getByRole('button', {name:'Start Wanix Linux', exact:true}).click();
  }
  const fallback = retry.dialog.getByRole('button', {name:'Start Alpine', exact:true});
  await fallback.waitFor();
  assert.equal(retry.alpine(), 0, 'NanoVM failure offers Alpine before downloading it');
  await fallback.click();
  await finished(retry.page, 'Alpine');
  assert.ok(retry.alpine() > 0);
  assert.equal((await bytesFrom(retry.page, retry.page.getByRole('link', {name:'Download libhello.a'})))
    .subarray(0, 8).toString(), '!<arch>\n');
  assert.equal(retry.archives(), 1, 'Alpine reuses the source archive');
  assert.deepEqual(retry.errors, []);
  console.log('Alpine started after fallback approval and completed the Make build');
}

try {
  const response = await fetch(new URL('settings.json', base));
  assert.ok(response.ok);
  const settings = await response.json();
  const archive = await nanoBuilds();
  if (settings.wanix) {
    await wanixBuild(archive);
    await wanixMakeLink();
    if (settings.wanix.chunks) await wanixNativeLink();
  }
  await alpineFallback(Boolean(settings.wanix));
} finally {
  await browser.close();
}
