import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {WASI} from 'node:wasi';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.WILLITWASM_URL || 'http://127.0.0.1:8327/';
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
try {
  const page = await browser.newPage({acceptDownloads:true});
  page.on('pageerror', error => console.error(error.message));
  await page.route('**/cmake-plan.json', route => route.fulfill({json:plan}));
  await page.goto(base + '?' + new URLSearchParams({repo:'https://github.com/' + plan.repo, plan:'cmake-plan.json'}));
  await page.locator('#workers').waitFor({state:'visible'});
  await page.locator('#workers').selectOption('4');
  await page.locator('#build').click();
  await page.waitForFunction(() => /^Build (complete|failed)/.test(document.querySelector('#plan-status').textContent),
    null, {timeout:120000});
  const status = await page.locator('#plan-status').innerText();
  if (!status.startsWith("Build complete")) await page.waitForTimeout(200);
  assert.match(status, /Build complete/, await page.locator('#console').innerText());
  const download = page.waitForEvent('download');
  await page.getByRole('link', {name:'Download ' + plan.output}).click();
  const bytes = await readFile(await (await download).path());
  const wasi = new WASI({version:'preview1'});
  const {instance} = await WebAssembly.instantiate(bytes, wasi.getImportObject());
  wasi.initialize(instance);
  if (plan.repo.toLowerCase() === 'madler/zlib') {
    const {memory, zlibVersion, compress2, uncompress, malloc} = instance.exports;
    const input = new TextEncoder().encode('A CMake build plan from zlib. '.repeat(100));
    const src = malloc(input.length), zipped = malloc(input.length + 64), result = malloc(input.length);
    const zippedLen = malloc(4), resultLen = malloc(4);
    const heap = () => new Uint8Array(memory.buffer), lengths = () => new DataView(memory.buffer);
    const version = zlibVersion();
    assert.equal(new TextDecoder().decode(heap().subarray(version, heap().indexOf(0, version))), '1.3.1');
    heap().set(input, src);
    lengths().setUint32(zippedLen, input.length + 64, true);
    lengths().setUint32(resultLen, input.length, true);
    assert.equal(compress2(zipped, zippedLen, src, input.length, 6), 0);
    assert.equal(uncompress(result, resultLen, zipped, lengths().getUint32(zippedLen, true)), 0);
    assert.deepEqual(heap().slice(result, result + lengths().getUint32(resultLen, true)), input);
    console.log(status, bytes.length, 'bytes, zlib 1.3.1 compression round trip passed');
  } else {
    const {XXH_versionNumber, XXH64} = instance.exports;
    assert.equal(XXH_versionNumber(), 803);
    assert.equal(BigInt.asUintN(64, XXH64(0, 0, 0n)), 0xef46db3751d8e999n);
    console.log(status, bytes.length, 'bytes, xxHash version and empty-input vector passed');
  }
} finally {await browser.close();}
