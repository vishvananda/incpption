import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const tasks = {
  lara: 'XProger/OpenLara',
  doom: 'gabrielcuvillier/d3wasm',
  godot: 'godotengine/godot',
};
const selected = process.argv.slice(2);
const browser = await chromium.launch({headless:true, args:['--no-sandbox','--enable-unsafe-swiftshader']});

async function check(id) {
  const repo = tasks[id];
  assert.ok(repo, 'Unknown example ' + id);
  const page = await browser.newPage({acceptDownloads:true, viewport:{width:1280, height:900}});
  page.on('pageerror', error => console.error(id, error.message));
  try {
    await page.goto(base + '?' + new URLSearchParams({repo:'https://github.com/' + repo}));
    await page.locator('#workers').waitFor({state:'visible', timeout:60000});
    assert.match(await page.locator('#target').innerText(), /Emscripten/);
    if (id === 'doom') {
      assert.match(await page.locator('#game-data-label').innerText(), /Game data.*MiB.*compilation/);
      assert.equal(await page.locator('#game-data-progress').isVisible(), false);
    }
    await page.locator('#workers').selectOption('4');
    await page.locator('#build').click();
    await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent),
      null, {timeout:1200000});
    const status = await page.locator('#plan-status').innerText();
    assert.match(status, /Build complete/, await page.locator('#console').innerText());
    if (id === 'doom' && await page.evaluate(() => typeof WebAssembly.promising === 'function')) {
      await page.waitForFunction(() => document.querySelector('#game-data-progress').value > 0,
        null, {timeout:120000});
    }
    const download = page.waitForEvent('download');
    await page.getByRole('link', {name:'Download ' + id + '.wasm'}).click();
    const file = await download;
    const bytes = await readFile(await file.path());
    const actual = createHash('sha256').update(bytes).digest('hex');
    const settings = await fetch(new URL('settings.json', base)).then(response => response.json());
    const manifest = await fetch(new URL((settings.sharedAssets ?? '') + 'projects/' + id + '/manifest.json', base)).then(response => response.json());
    assert.equal(actual, manifest.link.sha256);
    assert.equal(await page.locator('#progress').getAttribute('value'), await page.locator('#progress').getAttribute('max'));
    console.log(id, status, bytes.length, actual);
    if (id === 'lara') {
      await page.locator('#filter').fill('openlara/src/platform/web/main.cpp');
      const main = page.locator('[data-path="openlara/src/platform/web/main.cpp"]');
      await main.click();
      await page.waitForFunction(() => document.querySelector('#source .token'));
      await mkdir('test-results', {recursive:true});
      await page.screenshot({path:'test-results/desktop.png', fullPage:true});
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({path:'test-results/mobile.png', fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    }
  } finally {await page.close();}
}

try {
  for (const id of selected.length ? selected : Object.keys(tasks)) await check(id);
} finally {await browser.close();}
