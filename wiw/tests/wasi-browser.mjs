import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const repo = 'benhoyt/inih', commit = '5cc5e2c24642513aaa5b19126aad42d0e4e0923e';
const plan = {schema:'willitwasm/v1', kind:'wasi', repo, commit, sources:['ini.c'], files:['ini.h'],
  compileFlags:['-std=c17'], linkFlags:['-nostartfiles','--export=ini_parse_string'], output:'inih.wasm'};
const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads:true});
  page.on('pageerror', error => console.error(error.message));
  await page.route('**/wasi-demo.json', route => route.fulfill({json:plan}));
  const query = new URLSearchParams({repo:'https://github.com/' + repo, plan:'wasi-demo.json'});
  await page.goto(base + '?' + query);
  await page.locator('#build').waitFor({state:'visible'});
  assert.match(await page.locator('#plan-status').innerText(), /Shared link/);
  await page.locator('#build').click();
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent),
    null, {timeout:120000});
  const status = await page.locator('#plan-status').innerText();
  assert.match(status, /Build complete/, await page.locator('#console').innerText());
  const download = page.waitForEvent('download');
  await page.getByRole('link', {name:'Download inih.wasm'}).click();
  const bytes = await readFile(await (await download).path());
  assert.ok(WebAssembly.validate(bytes));
  const built = await WebAssembly.compile(bytes);
  assert.ok(WebAssembly.Module.exports(built).some(item => item.name === 'ini_parse_string'));
  console.log(status, bytes.length, 'bytes');
} finally {await browser.close();}
