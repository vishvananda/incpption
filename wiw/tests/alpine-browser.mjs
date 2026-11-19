import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const url = base + '?' + new URLSearchParams({repo:'https://github.com/benhoyt/inih',
  ref:'5cc5e2c24642513aaa5b19126aad42d0e4e0923e'});
const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads:true});
  page.on('pageerror', error => console.error(error.message));
  let guestRequests = 0;
  page.on('request', request => {if (/guest\.\d+\.bin/.test(request.url())) guestRequests++;});
  await page.goto(url);
  await page.locator('#generate').waitFor({state:'visible'});
  assert.equal(guestRequests, 0);
  const fixture = process.argv[2];
  if (fixture) {
    await page.locator('#plan-file').setInputFiles(fixture);
    await page.locator('#build').waitFor({state:'visible'});
    await page.locator('#build').click();
  } else {
    await page.locator('#generate').click();
    await page.locator('#plan-target').selectOption('x86_64-linux-musl');
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
  assert.equal(await page.locator('#results a').count(), 2);
  const saved = page.waitForEvent('download');
  await page.locator('#download-plan').click();
  const planFile = await (await saved).path();
  const bytes = await readFile(planFile);
  assert.ok(bytes.length > 1000);
  const cacheCount = await page.evaluate(async () => (await caches.keys()).filter(key => key.startsWith('willitwasm-alpine-')).length);
  assert.equal(cacheCount, fixture ? 0 : 1);
  await page.reload();
  if (!fixture) {
    await page.locator('#build').waitFor({state:'visible'});
    assert.match(await page.locator('#plan-status').innerText(), /Saved in this browser/);
  } else await page.locator('#generate').waitFor({state:'visible'});
  await page.locator('#plan-file').setInputFiles({name:'inih.wwplan', mimeType:'application/octet-stream', buffer:bytes});
  await page.waitForFunction(() => document.querySelector('#plan-status').textContent.startsWith('Plan file'));
  await page.locator('#build').click();
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent));
  assert.match(await page.locator('#plan-status').innerText(), /Build complete/);
  console.log(status);
} finally {await browser.close();}
