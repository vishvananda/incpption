#!/usr/bin/env node
// Real guided journey, including both code-generation targets and the game.
const fs = require('fs'), path = require('path'), http = require('http');
const [directory, playwright, mode = 'full', resultsDirectory = directory, executable] = process.argv.slice(2);
if (!directory || !playwright || !['full', 'inspector'].includes(mode))
  throw Error('usage: demo_browser_test.cjs COMPILER_PACKAGE PLAYWRIGHT_MODULE [full|inspector]');
const root = path.resolve(directory), out = path.resolve(resultsDirectory), pw = require(path.resolve(playwright));
fs.mkdirSync(out, {recursive: true});
const requests = [], errors = [];
const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  requests.push({method:req.method, url:req.url});
  if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + '/')) {res.writeHead(403);res.end();return;}
  if (process.env.DEMO_TEST_ISOLATION !== '0') {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  // Match Pages: precompressed binaries arrive without Content-Encoding.
  const stream = fs.createReadStream(file);
  stream.on('error',()=>{res.writeHead(404);res.end();});stream.pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await pw.chromium.launch({headless:true,executablePath:executable || undefined,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  const report={browser:browser.version(),mode,errors};
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    const liveWorkers = new Set();
    page.on('worker', worker => {liveWorkers.add(worker); worker.on('close', () => liveWorkers.delete(worker));});
    async function buildWorkersStopped() {
      for(let i=0;i<100;i++){
        if(![...liveWorkers].some(w=>/\/(compile_worker|wasi_worker|openlara_worker)\.mjs$/.test(w.url()))) return;
        await page.waitForTimeout(100);
      }
      throw Error('Build workers survived cancellation or completion');
    }
    page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});
    await page.goto((process.env.DEMO_TEST_ORIGIN || `http://127.0.0.1:${server.address().port}`) + '/wasi_demo.html');
    const github=page.locator('.header-actions a');
    if(await github.getAttribute('href')!=='https://github.com/vishvananda/cppgm-extended')throw Error('Wrong GitHub destination');
    const mark=await page.locator('.github-mark').evaluate(e=>({color:getComputedStyle(e).fill,path:e.querySelector('path')?.getAttribute('d')}));
    if(mark.color!=='rgb(190, 239, 138)' || !mark.path)throw Error('GitHub mark does not match theme');
    await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.shared=data;}}));
    await page.locator('#share').click();
    if(await page.evaluate(()=>window.shared.url)!=='https://incpption.com/')throw Error('Native share used the wrong URL');
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copied=value;}}});
    });
    await page.locator('#share').click();
    if(await page.evaluate(()=>window.copied)!=='https://incpption.com/')throw Error('Clipboard share failed');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('unavailable');}}}));
    await page.locator('#share').click();
    if(!await page.locator('#share-link').isVisible() || await page.locator('#share-link').inputValue()!=='https://incpption.com/')throw Error('Manual share fallback failed');
    await page.locator('#share-link').evaluate(e=>e.hidden=true);
    await page.locator('#share-status').evaluate(e=>e.textContent='');
    await page.locator('#share-feedback').evaluate(e=>e.hidden=true);
    report.headerPassed=true;
    if (!await page.locator('#game-build').isEnabled())throw Error('Supplied compiler cannot build the game first');
    await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source');
    if(requests.some(r=>/^\/compiler\//.test(r.url)))throw Error('Source browsing downloaded the compiler or SDK');
    if(!await page.locator('#source-highlight .token').count())throw Error('Default source browser is not highlighted');
    await page.screenshot({path:path.join(out,'site-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile page overflows');
    await page.screenshot({path:path.join(out,'site-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#source-project').selectOption('example');
    await page.waitForFunction(()=>['ready','error'].includes(window.lastInspectorEvent?.kind),null,{timeout:180000});
    async function compiled(target){
      await page.locator('#inspect-target').selectOption(target);
      await page.locator('#compile-example').click();
      await page.waitForFunction(()=>['compiled','error'].includes(window.lastInspectorEvent?.kind),null,{timeout:120000});
      const event=await page.evaluate(()=>window.lastInspectorEvent);
      if(event.kind==='error')throw Error(event.error);
      if(event.target!==target)throw Error('Stale target output');
      if(!event.lowir.includes('function'))throw Error('Missing real LowIR');
      if(!event.generated.includes(target==='wasm'?'i32.':'answer:'))throw Error('Missing decoded instructions');
      await page.locator('#tab-lowir').click();
      if(!await page.locator('#lowir-code .token').count())throw Error('LowIR syntax highlighting missing');
      await page.locator('#tab-generated').click();
      if(!await page.locator('#generated-code .token').count())throw Error('Generated code syntax highlighting missing');
      return event;
    }
    report.wasm=await compiled('wasm');
    await page.locator('#run-example').click();
    await page.waitForFunction(()=>window.lastInspectorRun!==undefined);
    if(await page.evaluate(()=>window.lastInspectorRun)!=='285')throw Error('Wrong Wasm execution result');
    report.x86=await compiled('x86');
    if(await page.locator('#run-example').isEnabled())throw Error('x86 output can be executed in browser');
    const download=page.waitForEvent('download');await page.locator('#object-download').click();
    const downloadPath=path.join(out,'inspector-x86.o');await(await download).saveAs(downloadPath);
    if(fs.readFileSync(downloadPath).subarray(0,4).toString('hex')!=='7f454c46')throw Error('Download is not an ELF object');
    await page.locator('#source-project').selectOption('cppgm');
    await page.locator('#file-filter').fill('sema/analyzer.h');
    await page.locator('#source-files button[aria-selected]').click();
    await page.waitForFunction(()=>document.getElementById('source-code').readOnly);
    if(!await page.locator('#source-highlight .token').count())throw Error('Source highlighting missing');
    if(await page.locator('#compile-example').isEnabled())throw Error('Read-only project file offered as standalone compile');
    await page.locator('#file-filter').fill('support/unicode/utf8.cpp');await page.locator('#source-files button[aria-selected]').click();
    await page.waitForFunction(()=>window.lastProjectEvent?.path==='dev/src/support/unicode/utf8.cpp');
    report.projectSource=await compiled('wasm');
    if(report.projectSource.project!=='cppgm')throw Error('Project source compilation did not use its own build settings');
    await page.locator('#source-project').selectOption('example');
    await page.locator('#tab-source').click();
    await page.locator('#source-code').fill('int broken=missing_name;');
    await page.locator('#compile-example').click();
    await page.waitForFunction(()=>window.lastInspectorEvent?.kind==='error');
    await page.locator('#tab-source').click();
    await page.locator('#source-code').fill('extern "C" int answer(int n){return n*7+3;}');
    await compiled('wasm');
    await page.evaluate(()=>delete window.lastInspectorRun);await page.locator('#run-example').click();
    await page.waitForFunction(()=>window.lastInspectorRun!==undefined);
    if(await page.evaluate(()=>window.lastInspectorRun)!=='73')throw Error('Edited example did not change output');
    report.inspectorPassed=true;
    await page.screenshot({path:path.join(out,'site-inspector.png'),fullPage:true});
    if(mode==='full'){
      await page.locator('.journey-nav [data-journey=game]').click();
      await page.locator('#game-build').click();
      await page.waitForFunction(()=>['complete','error'].includes(window.lastGameBuild?.kind),null,{timeout:300000});
      report.firstGame=await page.evaluate(()=>window.lastGameBuild);
      if(report.firstGame.kind!=='complete'||report.firstGame.compilerOrigin!=='seed')throw Error(report.firstGame.error||'First game did not use the supplied compiler');
      if(await page.locator('#source-files .project-row.built').count()!==3)throw Error('Game file progress did not complete');
      await page.locator('#game-play').click();
      await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:90000});
      if(await page.evaluate(()=>window.gameError))throw Error(await page.evaluate(()=>window.gameError));
      await page.waitForFunction(()=>window.openLaraGame?.drawCalls>150,null,{timeout:60000});
      await page.evaluate(()=>window.previousGame=window.openLaraGame);
      await page.locator('#next-inception').click();
      if(await page.evaluate(()=>window.gamePlaying))throw Error('Game continued running after leaving its step');
      const previousDraws=await page.evaluate(()=>window.previousGame.drawCalls);
      await page.waitForTimeout(300);
      if(await page.evaluate(()=>window.previousGame.drawCalls)!==previousDraws)throw Error('Closed game continued rendering');
      report.firstGamePlayPassed=true;
      await page.locator('.proof details>summary').click();
      await page.locator('#worker-choice').selectOption(process.env.DEMO_TEST_WORKERS || '8');
      if (process.env.DEMO_TEST_SECOND_BUILD === '1') await page.locator('#deep-verify').check();
      await page.locator('.proof details>summary').click();
      await page.locator('#start').click();
      await page.waitForFunction(()=>document.querySelectorAll('.unit.active').length>0,null,{timeout:180000});
      await page.locator('#cancel').click();
      await buildWorkersStopped();
      if(await page.locator('#downloads a').count() || !await page.locator('#game-compiler option[value=rebuilt]').evaluate(option => option.disabled))throw Error('Cancelled build published a compiler');
      report.cancellationPassed=true;
      await page.evaluate(()=>{
        window.maxConcurrentUnits=0;
        new MutationObserver(()=>{window.maxConcurrentUnits=Math.max(window.maxConcurrentUnits,document.querySelectorAll('.unit.active').length);}).observe(document.getElementById('units'),{subtree:true,attributes:true});
      });
      await page.locator('#start').click();
      await page.waitForFunction(()=>['complete','error'].includes(window.lastInceptionEvent?.kind),null,{timeout:3600000});
      report.inception=await page.evaluate(()=>window.lastInceptionEvent);
      await buildWorkersStopped();
      report.maxConcurrentUnits=await page.evaluate(()=>window.maxConcurrentUnits);
      if(report.maxConcurrentUnits<Math.min(2,report.inception.workerCount))throw Error('Compiler workers did not overlap');
      if(report.inception.kind!=='complete')throw Error(report.inception.error);
      if(report.inception.workerCount!==Number(process.env.DEMO_TEST_WORKERS || 8))throw Error('Wrong worker count');
      if(report.inception.stages.length!==(process.env.DEMO_TEST_SECOND_BUILD==='1'?2:1))throw Error('Wrong rebuild count');
      await page.locator('.proof details>summary').click();
      const compilerDownload=page.waitForEvent('download');
      await page.locator('#downloads a').first().click();
      const compilerPath=path.join(out,'guided-browser-cppgm.wasm');await(await compilerDownload).saveAs(compilerPath);
      const compilerHash=require('crypto').createHash('sha256').update(fs.readFileSync(compilerPath)).digest('hex');
      if(compilerHash!==report.inception.stages.at(-1).commands.at(-1).sha256)throw Error('Downloaded compiler differs');
      await page.locator('#build-with-rebuilt').click();
      await page.waitForFunction(()=>['progress','error'].includes(window.lastGameBuild?.kind),null,{timeout:180000});
      await page.locator('#game-cancel').click();
      await buildWorkersStopped();
      if(await page.locator('#game-play').isEnabled())throw Error('Cancelled build allowed play');
      await page.locator('#game-build').click();
      await page.waitForFunction(()=>['complete','error'].includes(window.lastGameBuild?.kind),null,{timeout:300000});
      report.game=await page.evaluate(()=>window.lastGameBuild);
      await buildWorkersStopped();
      if(report.game.kind!=='complete'||report.game.compilerOrigin!=='rebuilt')throw Error(report.game.error||'Second game did not use the rebuilt compiler');
      report.compilerFileMatches=await page.evaluate(()=>Array.from(document.querySelectorAll('#units .unit.done')).length);
      if(report.compilerFileMatches!==report.inception.stages.at(-1).commands.length)throw Error('Build and match display missed outputs');
      const download=page.waitForEvent('download');
      await page.locator('#game-build-details>summary').click();
      await page.locator('#game-downloads a').first().click();
      const gamePath=path.join(out,'guided-browser-openlara.wasm');await(await download).saveAs(gamePath);
      const gameHash=require('crypto').createHash('sha256').update(fs.readFileSync(gamePath)).digest('hex');
      if(gameHash!==report.game.commands.at(-1).sha256)throw Error('Downloaded game differs');
      await page.locator('#game-play').click();
      await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:90000});
      if(await page.evaluate(()=>window.gameError))throw Error(await page.evaluate(()=>window.gameError));
      await page.waitForFunction(()=>window.openLaraGame.drawCalls>1200,null,{timeout:60000});
      await page.frameLocator('#game-frame').locator('#canvas').click();
      await page.keyboard.down('ArrowUp');await page.waitForTimeout(1600);await page.keyboard.up('ArrowUp');
      report.drawCalls=await page.evaluate(()=>window.openLaraGame.drawCalls);
      await page.screenshot({path:path.join(out,'site-game.png'),fullPage:true});
    }
    if(requests.some(r=>!['GET','HEAD'].includes(r.method)))throw Error('Build sent data to the server');
    report.staticRequestsOnly=true;
    if(errors.length)throw Error('Page produced JavaScript errors');
    report.passed=true;console.log(`PASS: ${mode} browser journey`);
  }finally{
    report.requests=requests;
    fs.writeFileSync(path.join(out,`site-${mode}-results.json`),JSON.stringify(report,null,2)+'\n');
    await browser.close();server.close();
  }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
