import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const url = base + '?' + new URLSearchParams({repo:'https://github.com/benhoyt/inih',
  ref:'5cc5e2c24642513aaa5b19126aad42d0e4e0923e'});
const settings = await fetch(new URL('settings.json', base)).then(response => response.json());
const wanix = Boolean(settings.wanix?.chunks);
const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads:true});
  page.on('pageerror', error => console.error(error.message));
  let guestRequests = 0;
  let alpineRequests = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/guest\.\d+\.bin$/.test(path)) alpineRequests++;
    if (/\/wanix\//.test(path) || /guest\.\d+\.bin$/.test(path)) guestRequests++;
  });
  if (process.env.WILLITWASM_TRACE) {
    await page.exposeFunction('wwTrace', line => console.log(line));
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const output = document.getElementById('console');
      if (output) new MutationObserver(() => globalThis.wwTrace(output.textContent.trim().split('\n').at(-1)))
        .observe(output, {childList:true, subtree:true, characterData:true});
    }));
  }
  await page.goto(url);
  await page.getByText(/No build plan found/).waitFor();
  assert.equal(guestRequests, 0);
  const fixture = process.argv[2];
  if (fixture) {
    await page.locator('#plan-file').setInputFiles(fixture);
    await page.waitForFunction(() => document.querySelector('#plan-status').textContent.startsWith('Plan file'));
    await page.locator('#build').click();
  } else {
    await page.locator('#build').click();
    await page.locator('#plan-target').selectOption('x86_64-linux-musl');
    if (wanix) {
      await page.getByRole('button', {name:'Start Wanix Linux'}).click();
      await page.getByRole('button', {name:'Start Alpine'}).waitFor({timeout:300000});
      assert.equal(alpineRequests, 0, 'Alpine waits for fallback approval');
    }
    await page.getByRole('button', {name:'Start Alpine'}).click();
  }
  await page.waitForFunction(() => /^(Build complete|Build failed|Plan generation failed)/.test(document.querySelector('#plan-status').textContent),
    null, {timeout:900000});
  const status = await page.locator('#plan-status').innerText();
  if (!status.startsWith('Build complete')) await page.waitForTimeout(150);
  const output = await page.locator('#console').innerText();
  assert.match(status, /Build complete/, output);
  if (!fixture) {
    assert.match(output, /\+ meson setup/);
    assert.match(output, /Plan saved in this browser/);
    assert.ok(guestRequests > 0);
  }
  assert.match(await page.locator('#target').innerText(), /Linux.*musl/);
  const products = page.locator('#results a');
  assert.equal(await products.count(), 2);
  const download = page.waitForEvent('download');
  await products.first().click();
  const binary = await readFile(await (await download).path());
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(binary[4], 2, 'ELF64');
  assert.equal(binary.readUInt16LE(18), 62, 'x86-64');
  const saved = page.waitForEvent('download');
  await page.locator('#download-plan').click();
  const planFile = await (await saved).path();
  const bytes = await readFile(planFile);
  assert.ok(bytes.length > 1000);
  const cacheCount = await page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('willitwasm-alpine-')).length);
  assert.equal(cacheCount, fixture ? 0 : 1);
  const requestsBeforeReplay = guestRequests;
  await page.reload();
  if (!fixture) {
    await page.getByText(/Saved in this browser/).waitFor();
  } else await page.getByText(/No build plan found/).waitFor();
  await page.locator('#plan-file').setInputFiles({name:'inih.wwplan', mimeType:'application/octet-stream', buffer:bytes});
  await page.waitForFunction(() => document.querySelector('#plan-status').textContent.startsWith('Plan file'));
  await page.locator('#build').click();
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent));
  assert.match(await page.locator('#plan-status').innerText(), /Build complete/);
  assert.equal(guestRequests, requestsBeforeReplay);
  console.log(status);
} finally {await browser.close();}
