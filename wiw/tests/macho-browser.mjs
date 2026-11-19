import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const engine = playwright[process.env.WILLITWASM_BROWSER || 'chromium'];
const browser = await engine.launch({headless:true, args:engine.name() === 'chromium' ? ['--no-sandbox'] : []});

function checkMachO(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(bytes.readUInt32LE(4), 0x0100000c);
  assert.equal(bytes.readUInt32LE(12), 2);
  const commands = new Map();
  for (let count = bytes.readUInt32LE(16), offset = 32; count > 0; count--) {
    commands.set(bytes.readUInt32LE(offset), offset);
    const length = bytes.readUInt32LE(offset + 4);
    assert.ok(length >= 8);
    offset += length;
  }
  const version = commands.get(0x32);
  assert.equal(bytes.readUInt32LE(version + 8), 1);
  assert.equal(bytes.readUInt32LE(version + 12), 11 << 16);
  assert.ok(commands.has(0x80000028));
  assert.ok(commands.has(0x1d));
  const dylib = commands.get(0xc);
  const name = dylib + bytes.readUInt32LE(dylib + 8);
  assert.equal(bytes.toString('utf8', name, bytes.indexOf(0, name)), '/usr/lib/libSystem.B.dylib');
}

try {
  const page = await browser.newPage({acceptDownloads:true});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#repo').fill('https://github.com/benhoyt/inih');
  await page.getByRole('button', {name:'Build', exact:true}).click();
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent),
    null, {timeout:120000});
  const status = await page.locator('#plan-status').innerText();
  if (status.startsWith('Build failed')) await page.waitForTimeout(100);
  assert.match(status, /^Build complete/, await page.locator('#console').innerText());
  assert.match(await page.locator('#target').innerText(), /macOS arm64.*Mach-O/);

  const binary = page.waitForEvent('download');
  await page.getByRole('link', {name:'Download inih', exact:true}).click();
  const bytes = await readFile(await (await binary).path());
  checkMachO(bytes);
  if (process.env.MACHO_OUTPUT) await writeFile(process.env.MACHO_OUTPUT, bytes, {mode:0o755});

  const exported = page.waitForEvent('download');
  await page.getByRole('button', {name:'Download plan', exact:true}).click();
  const plan = await readFile(await (await exported).path());
  assert.equal(JSON.parse(plan).kind, 'macho');
  await page.locator('#plan-file').setInputFiles({name:'inih-macos-arm64.json', mimeType:'application/json', buffer:plan});
  await page.getByText(/Plan file.*cppgm v0\.9\.7/).waitFor();

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const temp = await mkdtemp(join(tmpdir(), 'wiw-macho-'));
    try {
      const command = join(temp, 'inih'), input = join(temp, 'settings.ini');
      await writeFile(command, bytes);
      await chmod(command, 0o755);
      await writeFile(input, '[build]\ntarget = arm64\n');
      execFileSync('codesign', ['--verify', command]);
      assert.equal(execFileSync(command, [input], {encoding:'utf8'}), 'build.target=arm64\n');
    } finally {await rm(temp, {recursive:true, force:true});}
  }
  assert.deepEqual(errors, []);
  console.log(status, bytes.length, 'bytes, arm64 Mach-O and reusable profile verified');
} finally {await browser.close();}
