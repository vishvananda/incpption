import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const [path, selectedAction] = process.argv.slice(2);
assert.ok(path, 'Pass the URL of a staged Emscripten plan.');
const plan = await fetch(new URL(path, base)).then(response => response.json());
const settings = await fetch(new URL('settings.json', base)).then(response => response.json());
const prepared = settings.preparedPlans?.[plan.repo.toLowerCase()];
const fromPicker = prepared && new URL(prepared, base).href === new URL(path, base).href && !process.env.WILLITWASM_WORKERS;
const action = selectedAction ?? (plan.repo === 'godotengine/godot' ? 'godot' : null);
const browser = await chromium.launch({headless:true, args:['--no-sandbox', '--enable-unsafe-swiftshader']});

async function play(page, zip, names) {
  const mime = {html:'text/html', js:'text/javascript', wasm:'application/wasm', woff2:'font/woff2', json:'application/json'};
  const data = new Map(names.map(name => [name, execFileSync('unzip', ['-p', zip, name], {maxBuffer:512 * 1024 * 1024})]));
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!data.has(name)) {response.writeHead(404).end();return;}
    response.writeHead(200, {'Content-Type':mime[name.split('.').pop()] ?? 'application/octet-stream'}).end(data.get(name));
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await page.goto('http://127.0.0.1:' + server.address().port + '/' + plan.entry);
    if (action === 'godot') {
      await page.locator('#welcome-modal-dismiss').click();
      await page.locator('#startButton').click();
      await page.locator('#editor-canvas').waitFor({state:'visible', timeout:120000});
      return;
    }
    await page.waitForFunction(() => globalThis.Module?.calledRun && document.querySelector('canvas')?.width > 0,
      null, {timeout:60000});
  } finally {server.close();}
}

async function playTetris(page) {
  await page.getByRole('button', {name:'Play', exact:true}).click();
  const frame = page.frameLocator('#player-surface iframe');
  const canvas = frame.locator('canvas');
  await canvas.evaluate(element => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {clearInterval(poll);reject(Error('The SDL game did not start'));}, 20000);
    const poll = setInterval(() => {
      if (!globalThis.Module?.calledRun || element.width === 0) return;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve();
    }, 50);
  }));
  assert.equal(await canvas.evaluate(() => self.origin), 'null');
  await canvas.click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  assert.equal(await frame.locator('#status').innerText(), '');
  assert.ok((await canvas.screenshot()).length > 2000, 'Expected SDL Tetris to render');
  await page.getByRole('button', {name:'Close', exact:true}).click();
  await page.locator('#player-surface iframe').waitFor({state:'detached'});
}

try {
  const page = await browser.newPage({acceptDownloads:true});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (fromPicker) {
    await page.goto(base);
    await page.locator('#repo').fill('https://github.com/' + plan.repo);
  } else await page.goto(base + '?' + new URLSearchParams({repo:plan.repo, plan:path}));
  if (process.env.WILLITWASM_WORKERS) {
    await page.locator('#workers').waitFor({state:'visible'});
    await page.locator('#workers').selectOption(process.env.WILLITWASM_WORKERS);
  }
  await page.locator('#build').click({timeout:60000});
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent),
    null, {timeout:1200000});
  const status = await page.locator('#plan-status').innerText();
  assert.equal(await page.locator('#alpine-dialog').isVisible(), false);
  if (status.startsWith('Build failed')) {
    await page.waitForTimeout(100);
    assert.fail((await page.locator('#console').innerText()).split('\n').slice(-10).join('\n'));
  }
  const output = page.waitForEvent('download');
  await page.getByRole('link', {name:/^Download .*\.zip$/}).click();
  const zip = await (await output).path();
  const names = execFileSync('unzip', ['-Z1', zip], {encoding:'utf8'}).trimEnd().split('\n');
  assert.ok(names.includes(plan.entry));
  const wasm = execFileSync('unzip', ['-p', zip, plan.output], {maxBuffer:512 * 1024 * 1024});
  assert.equal(createHash('sha256').update(wasm).digest('hex'), plan.sha256);
  assert.ok(WebAssembly.validate(wasm));
  if (action === 'tetris') await playTetris(page);
  else if (action) await play(page, zip, names);
  assert.deepEqual(errors, []);
  console.log(plan.repo, status, (await readFile(zip)).length, plan.sha256, action ? 'page ran' : '');
} finally {await browser.close();}
