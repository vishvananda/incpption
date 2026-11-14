#!/usr/bin/env node
const fs = require('fs'), path = require('path'), http = require('http');
const [directory, playwright, resultsDirectory] = process.argv.slice(2);
if (!directory || !playwright) throw Error('usage: openlara_browser_test.cjs COMPILER_PACKAGE PLAYWRIGHT_MODULE');
const root = path.resolve(directory), pw = require(path.resolve(playwright));
const requests = [];
const server = http.createServer((req, res) => {
  requests.push({method: req.method, url: req.url});
  if (!['GET', 'HEAD'].includes(req.method)) {res.writeHead(405); res.end(); return;}
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + '/')) {res.writeHead(403); res.end(); return;}
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Content-Type', file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript'
    : file.endsWith('.html') ? 'text/html' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
  const stream = fs.createReadStream(file);
  stream.on('error', () => {res.writeHead(404); res.end();}); stream.pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await pw.chromium.launch({headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader']});
  const report = {browser: browser.version(), errors: [], console: []};
  const out = resultsDirectory ? path.resolve(resultsDirectory) : path.join(root, 'openlara');
  fs.mkdirSync(out, {recursive: true});
  try {
    const page = await browser.newPage({viewport: {width: 1120, height: 900}, acceptDownloads: true});
    page.on('pageerror', error => {report.errors.push(String(error)); console.error(String(error));});
    page.on('console', entry => report.console.push({type: entry.type(), text: entry.text()}));
    await page.goto((process.env.DEMO_TEST_ORIGIN || `http://127.0.0.1:${server.address().port}`) + '/openlara.html');
    await page.locator('#start').click();
    await page.waitForFunction(() => ['progress', 'error'].includes(window.lastGameBuild?.kind), null, {timeout: 180000});
    if (await page.evaluate(() => window.lastGameBuild.kind) === 'error')
      throw Error(await page.evaluate(() => window.lastGameBuild.error));
    await page.locator('#cancel').click();
    if (await page.locator('#downloads a').count()) throw Error('cancelled run published an artifact');
    report.cancellationPassed = true;
    await page.locator('#start').click();
    await page.waitForFunction(() => ['complete', 'error'].includes(window.lastGameBuild?.kind), null, {timeout: 300000});
    report.build = await page.evaluate(() => window.lastGameBuild);
    if (report.build.kind !== 'complete') throw Error(report.build.error);
    const download = page.waitForEvent('download');
    await page.locator('#downloads a').click();
    const downloaded = path.join(out, 'browser-openlara.wasm');
    await (await download).saveAs(downloaded);
    if (require('crypto').createHash('sha256').update(fs.readFileSync(downloaded)).digest('hex') !== report.build.commands.at(-1).sha256)
      throw Error('downloaded game differs from native-produced reference');
    await page.locator('#play').click();
    await page.waitForFunction(() => window.gamePlaying || window.gameError, null, {timeout: 60000});
    const error = await page.evaluate(() => window.gameError);
    if (error) throw Error(error);
    await page.waitForFunction(() => window.openLaraGame?.drawCalls > 150, null, {timeout: 60000});
    await page.locator('#canvas').click();
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowUp');
    report.drawCalls = await page.evaluate(() => window.openLaraGame.drawCalls);
    await page.screenshot({path: path.join(out, 'browser-game.png'), fullPage: true});
    if (report.errors.length) throw Error('game produced JavaScript errors');
    report.passed = true;
    console.log(`Browser build/play passed: ${report.build.seconds.toFixed(1)}s, ${report.drawCalls} actual draw calls`);
  } finally {
    report.requests = requests;
    fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n');
    await browser.close(); server.close();
  }
})().catch(error => {console.error(error); server.close(); process.exitCode = 1;});
