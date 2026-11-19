import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {unpackPlan} from '../web/plans.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const repo = 'fukuchi/libqrencode';
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads:true});
  const errors = [];
  let guestRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (/guest\.\d+\.bin/.test(request.url())) guestRequests++;});
  if (process.env.WILLITWASM_TRACE) {
    await page.exposeFunction('wwTrace', line => console.log(line));
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const target = document.getElementById('console');
      if (target) new MutationObserver(() => {
        const last = target.textContent.trim().split('\n').at(-1);
        if (last) globalThis.wwTrace(last);
      }).observe(target, {childList:true, subtree:true, characterData:true});
    }));
  }
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#examples option').length === 5);
  await page.locator('#repo').fill('https://github.com/' + repo);
  await page.getByRole('button', {name:'Find build plan'}).click();
  await page.locator('#generate').click();
  assert.equal(guestRequests, 0);
  assert.equal(await page.locator('#plan-target').inputValue(), 'wasm32-wasip1');
  await page.getByRole('button', {name:'Start Alpine'}).click();
  await page.waitForFunction(() => /^(Build complete|Build failed|Plan generation failed)/.test(
    document.querySelector('#plan-status').textContent), null, {timeout:900000});
  const status = await page.locator('#plan-status').innerText();
  if (!status.startsWith('Build complete')) await page.waitForTimeout(120);
  assert.match(status, /^Build complete/, await page.locator('#console').innerText());
  assert.match(await page.locator('#target').innerText(), /Wasm.*WASI/);
  assert.ok(guestRequests > 0);

  const saved = page.waitForEvent('download');
  await page.locator('#download-plan').click();
  const plan = await unpackPlan(new Uint8Array(await readFile(await (await saved).path())), {repo});
  assert.equal(plan.target, 'wasm32-wasip1');
  const executable = page.waitForEvent('download');
  await page.getByRole('link', {name:'Download qrencode.wasm'}).click();
  assert.ok(WebAssembly.validate(await readFile(await (await executable).path())));

  await page.getByRole('button', {name:'Try QR generator'}).click();
  const image = page.getByRole('img', {name:'Generated QR code'});
  await image.waitFor({state:'visible'});
  await page.waitForFunction(() => document.querySelector('#qr-dialog img').naturalWidth > 0);
  const before = await image.getAttribute('src');
  await page.locator('#qr-text').fill('Will it Wasm?');
  await page.getByRole('button', {name:'Generate QR'}).click();
  await page.waitForFunction(previous => {
    const img = document.querySelector('#qr-dialog img');
    return img.src !== previous && img.complete && img.naturalWidth > 0;
  }, before);
  await page.locator('#close-qr').click();

  const requests = guestRequests;
  await page.reload();
  await page.locator('#build').waitFor({state:'visible'});
  assert.match(await page.locator('#plan-status').innerText(), /Saved in this browser/);
  assert.equal(guestRequests, requests);
  assert.deepEqual(errors, []);
  console.log('QR Code generator', status, 'Wasm, SVG preview, and saved plan verified');
} finally {await browser.close();}
