const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(process.argv[2] || 'dist');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.writeHead(404).end());
  stream.pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/report.html`);
    assert.equal(await page.title(), 'Compilation cost study · cppgm inception');
    assert.equal(await page.locator('.phase').count(), 4);
    assert.equal(await page.locator('.bar[role=img][aria-label]').count(), 8);
    assert.equal(await page.locator('.phase').first().locator('.clang span').textContent(), '126.3');
    assert.equal(await page.locator('.phase').first().locator('.clang').getAttribute('aria-label'), 'Clang: 126.3 billion instructions');
    assert.equal(await page.locator('.phase').first().locator('.cppgm').getAttribute('aria-label'), 'cppgm: 42.2 billion instructions');
    assert.equal(await page.locator('.phase').first().locator('.share').textContent(), '54% of attributed gap');
    await page.getByLabel('Cycles', { exact: true }).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#metric-name').textContent(), 'cycles');
    assert.equal(await page.locator('.phase').first().locator('.clang span').textContent(), '168.6');
    assert.equal(await page.locator('.phase').first().locator('.cppgm span').textContent(), '37.3');
    assert.equal(await page.locator('.phase').first().locator('.clang').getAttribute('aria-label'), 'Clang: 168.6 billion cycles');
    assert.equal(await page.locator('.phase').first().locator('.cppgm').getAttribute('aria-label'), 'cppgm: 37.3 billion cycles');
    assert.equal(await page.locator('.phase').first().locator('.share').textContent(), '59% of attributed gap');
    assert.equal(await page.locator('.phase').last().locator('.share').textContent(), '10% of attributed gap');
    for (const phase of await page.locator('.phase').all()) {
      for (const compiler of ['clang', 'cppgm']) {
        const bar = phase.locator(`.${compiler}`);
        const value = await bar.locator('span').textContent();
        assert.equal(await bar.getAttribute('aria-label'), `${compiler === 'clang' ? 'Clang' : 'cppgm'}: ${value} billion cycles`);
      }
    }
    await page.getByText('What was measured and estimated?').click();
    assert.equal(await page.locator('details').first().getAttribute('open'), '');
    await page.locator('#lexing-evidence summary').click();
    assert.equal(await page.locator('#lexing-evidence').getAttribute('open'), '');
    for (const group of await page.locator('#improvements .improvement-group').all()) {
      assert.equal(await group.isVisible(), true);
      const id=await group.getAttribute('id');
      assert.equal(await page.locator(`#method #${id}`).count(), 0);
    }
    assert.match(await page.locator('#lexing-evidence').innerText(), /5\.57 \/ 3\.99/);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
    }
    assert.deepEqual(errors, []);
    const noJS = await browser.newPage({ javaScriptEnabled: false });
    await noJS.goto(`${base}/report.html`);
    assert.equal(await noJS.locator('.phase').first().locator('.clang span').textContent(), '126.3');
    assert.equal(await noJS.locator('.phase').first().locator('.clang').getAttribute('aria-label'), 'Clang: 126.3 billion instructions');
    assert.equal(await noJS.locator('a.brand').getAttribute('href'), './');
    assert.equal(await noJS.getByLabel('Cycles', { exact: true }).isDisabled(), true);
    await noJS.close();
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(index, /href="\.\/report\.html"[^>]*>Analysis<\/a>/);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('footer a[href="./report.html"]').isVisible(), true);
    for (const link of await page.locator('a[href="./report.html"]').all()) {
      assert.equal(await link.getAttribute('target'), '_blank', 'Opening the report must preserve the running demo');
      assert.match(await link.getAttribute('rel'), /noopener/);
    }
    assert.match(fs.readFileSync(path.join(root, 'report.html'), 'utf8'), /assets\/report\.[a-f0-9]+\.css/);
    console.log('Report browser checks passed.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
