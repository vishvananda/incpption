#!/usr/bin/env node
// Real guided journey, including both code-generation targets and the game.
const fs = require('fs'), path = require('path'), http = require('http');
const [directory, playwright, mode = 'full', resultsDirectory = directory, executable] = process.argv.slice(2);
if (!directory || !playwright || !['full', 'inspector', 'roundtrip', 'modal'].includes(mode))
  throw Error('usage: demo_browser_test.cjs COMPILER_PACKAGE PLAYWRIGHT_MODULE [full|inspector]');
const root = path.resolve(directory), out = path.resolve(resultsDirectory), pw = require(path.resolve(playwright));
fs.mkdirSync(out, {recursive: true});
const requests = [], errors = [];
let progressTimer;
const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  requests.push({method:req.method, url:req.url});
  if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405);res.end();return;}
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root + '/')) {res.writeHead(403);res.end();return;}
  if (process.env.DEMO_TEST_ISOLATION !== '0') {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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
  const browser=await pw.chromium.launch({headless:true,executablePath:executable || undefined,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--site-per-process']});
  const report={browser:browser.version(),mode,errors};
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
    if (process.env.DEMO_TEST_CPU_RATE) {const cdp=await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.DEMO_TEST_CPU_RATE)});}
    // Real software WebGL can delay compositor frames on small CI runners.
    page.setDefaultTimeout(120000);
    const liveWorkers = new Set();
    page.on('worker', worker => {liveWorkers.add(worker); worker.on('close', () => liveWorkers.delete(worker));});
    async function buildWorkersStopped() {
      for(let i=0;i<100;i++){
        if(![...liveWorkers].some(w=>/\/(compile_worker|wasi_worker|openlara_worker|llvm_worker|clang_worker)\.mjs$/.test(w.url()))) return;
        await page.waitForTimeout(100);
      }
      throw Error('Build workers survived cancellation or completion');
    }
    if(process.env.DEMO_TEST_TRACE){
      await page.context().tracing.start({screenshots:true,snapshots:true,sources:true});
      page.on('console',m=>console.log('PAGE '+m.text()));
    }
    page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});
    if(!process.env.DEMO_TEST_ORIGIN)await page.addInitScript(url=>window.incpptionPlayerURL=url,`http://localhost:${server.address().port}/game_frame.html`);
    await page.goto((process.env.DEMO_TEST_ORIGIN || `http://127.0.0.1:${server.address().port}`) + '/wasi_demo.html');
    const github=page.locator('.header-actions a');
    if(await github.getAttribute('href')!=='https://github.com/vishvananda/incpption')throw Error('Wrong GitHub destination');
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
    await page.waitForFunction(()=>!document.getElementById('run-workflow').disabled);
    if (!await page.locator('[data-phase=game]').isEnabled())throw Error('Supplied compiler cannot build the game first');
    await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source');
    if(requests.some(r=>/^\/compiler\//.test(r.url)))throw Error('Source browsing downloaded the compiler or SDK');
    if(!await page.locator('#source-highlight .token').count())throw Error('Default source browser is not highlighted');
    await page.screenshot({path:path.join(out,'site-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile page overflows');
    await page.screenshot({path:path.join(out,'site-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    if(mode !== 'roundtrip' && mode !== 'modal') {
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
    await page.locator('#source-project').selectOption('game');
    report.gameProjectSources=[];
    for(const source of ['openlara/src/platform/web/main.cpp','openlara/src/libs/stb_vorbis/stb_vorbis.c','openlara/src/libs/tinf/tinflate.c']){
      await page.locator('#file-filter').fill(source);
      await page.locator('#source-files button[aria-selected]').click();
      await page.waitForFunction(source=>window.lastProjectEvent?.path===source,source);
      const event=await compiled('wasm');
      if(event.project!=='game')throw Error('Game source compilation did not use its own build settings');
      report.gameProjectSources.push({path:source,lowirLength:event.lowir.length,generatedLength:event.generated.length});
      if(source.endsWith('/main.cpp')){
        for(const [id,contents] of [['lowir',event.lowir],['generated',event.generated]]){
          await page.locator('#tab-'+id).click();
          if((await page.locator('#'+id+'-code').textContent()).length>120000)throw Error('Large output preview is unbounded');
          if(contents.length>120000&&!await page.locator('#'+id+'-preview').textContent())throw Error('Truncated output has no explanation');
          const pending=page.waitForEvent('download');await page.locator('#'+id+'-download').click();
          const target=path.join(out,'openlara-main.'+id);await(await pending).saveAs(target);
          if(fs.readFileSync(target,'utf8')!==contents)throw Error('Complete output download differs from compiler output');
        }
        report.largeOutputDownloadsPassed=true;
      }
    }
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
    }
    if(mode==='full' || mode==='roundtrip' || mode==='modal'){
      const journey = mode === 'roundtrip' ? 'roundtrip' : 'game';
      await page.locator(`.journey-nav [data-journey=${journey}]`).click();
      if(mode === 'roundtrip') {
        if(await page.locator('[data-phase=clang]').isEnabled())throw Error('Clang phase can run without LLVM');
        if(await page.locator('[data-phase=match]').isEnabled())throw Error('Match phase can run without Clang');
      }
      await page.locator('#run-workflow').click();
      progressTimer = setInterval(async () => {
        try {
          const status = await page.evaluate(()=>({phase:window.lastWorkflowEvent?.phase,kind:window.lastWorkflowEvent?.kind,
            processed:document.getElementById('completed').textContent,time:document.getElementById('workflow-time').textContent}));
          fs.appendFileSync(path.join(out,'progress.jsonl'),JSON.stringify(status)+'\n');
          console.log(JSON.stringify(status));
        } catch {}
      }, 10000);
      await page.waitForFunction(()=>window.gamePlaying||window.gameError||window.lastWorkflowEvent?.kind==='error',null,{timeout:5400000});
      clearInterval(progressTimer);
      if(await page.evaluate(()=>window.lastWorkflowEvent?.kind==='error'))throw Error(await page.evaluate(()=>window.lastWorkflowEvent.error));
      if(await page.evaluate(()=>window.gameError))throw Error(await page.evaluate(()=>window.gameError));
      await page.frameLocator('#game-frame').locator('#canvas').click();
      await page.waitForFunction(()=>window.openLaraGame?.drawCalls>150,null,{timeout:60000});
      report.playerOrigin=new URL(await page.locator('#game-frame').getAttribute('src')).origin;
      if(report.playerOrigin===new URL(page.url()).origin)throw Error('Game shares the build page origin');
      if(!await page.locator('#game-modal').evaluate(e=>e.open))throw Error('Workflow did not open game modal');
      if(process.env.DEMO_TEST_TRACE) await page.evaluate(()=>{
        const log=s=>console.log('MODAL '+performance.now().toFixed(1)+' '+s),modal=document.getElementById('game-modal'),button=document.getElementById('game-close');
        for(const type of ['pointerdown','mousedown','mouseup','click'])button.addEventListener(type,()=>log(type),true);
        modal.addEventListener('close',()=>log('close event'));
        const close=modal.close.bind(modal);modal.close=(...args)=>{log('dialog.close enter');const r=close(...args);log('dialog.close exit');return r;};
        const frame=document.getElementById('game-frame'),player=window.openLaraGame,stop=player.close.bind(player);
        player.close=(...args)=>{log('player.close enter');const r=stop(...args);log('player.close exit');return r;};
        const remove=frame.remove.bind(frame);frame.remove=(...args)=>{log('remove enter');const r=remove(...args);log('remove exit');return r;};
        const replace=frame.replaceWith.bind(frame);frame.replaceWith=(...args)=>{log('replace enter');const r=replace(...args);log('replace exit');return r;};
      });
      await page.evaluate(()=>window.openLaraGame.pause());
      await page.screenshot({path:path.join(out,'site-game.png'),fullPage:true});
      await page.evaluate(async()=>{await window.openLaraGame.resume();window.lastClosedGame=window.openLaraGame;});
      await page.locator('#game-close').click();
      const closedDraws=await page.evaluate(()=>window.lastClosedGame.drawCalls);
      await page.waitForTimeout(300);
      if(await page.evaluate(()=>window.lastClosedGame.drawCalls)!==closedDraws)throw Error('Closed game continued rendering');
      await page.waitForFunction(()=>window.lastClosedGame.closed && !document.getElementById('game-frame'));
      await page.evaluate(()=>delete window.lastClosedGame);
      if(await page.evaluate(()=>window.gamePlaying))throw Error('Closed modal kept game running');
      report.firstGame=await page.evaluate(()=>window.lastGameBuild);
      await buildWorkersStopped();
      if(mode === 'full') {
        await page.locator('.journey-nav [data-journey=inception]').click();
        if(await page.locator('[data-phase=game]').isEnabled())throw Error('Game can run before matching');
        await page.locator('#worker-choice').evaluate((e,value)=>e.value=value,process.env.DEMO_TEST_WORKERS || '8');
        await page.locator('[data-phase=match]').click();
        await page.waitForFunction(()=>document.querySelectorAll('.unit.active').length>0,null,{timeout:180000});
        await page.locator('#cancel').click();
        await buildWorkersStopped();
        if(await page.locator('#game-play').isEnabled())throw Error('Cancelled build allowed play');
        report.cancellationPassed=true;
        await page.evaluate(()=>{
          window.maxConcurrentUnits=0;
          new MutationObserver(()=>{window.maxConcurrentUnits=Math.max(window.maxConcurrentUnits,document.querySelectorAll('.unit.active').length);}).observe(document.getElementById('units'),{subtree:true,attributes:true});
        });
        await page.locator('[data-phase=match]').click();
        await page.waitForFunction(()=>['complete','error'].includes(window.lastInceptionEvent?.kind),null,{timeout:3600000});
        report.inception=await page.evaluate(()=>window.lastInceptionEvent);
        if(report.inception.kind!=='complete')throw Error(report.inception.error);
        await buildWorkersStopped();
        if(await page.locator('.unit.matched').count()!==report.inception.stages[0].commands.length)throw Error('Grid did not show every matched output');
        if(!await page.locator('[data-phase=match] .node-check').textContent().then(s=>s.includes('matches')))throw Error('Missing match check on flow');
        const phaseTime=await page.locator('[data-phase=match] time').textContent();
        if(phaseTime==='0:00')throw Error('Completed phase lost its time');
        await page.locator('[data-phase=game]').click();
        if(await page.locator('[data-phase=match] time').textContent()!==phaseTime)throw Error('Grid reset also reset the completed phase time');
        await page.waitForFunction(()=>['complete','error'].includes(window.lastGameBuild?.kind),null,{timeout:300000});
        report.game=await page.evaluate(()=>window.lastGameBuild);if(report.game.kind!=='complete')throw Error(report.game.error);
        const gameTime=await page.locator('[data-phase=game] time').textContent();
        await page.locator('[data-phase=match]').click();
        if(await page.locator('#cancel').isEnabled())throw Error('Reviewing the matched compiler started a rebuild');
        if(await page.locator('.unit.matched').count()!==report.inception.stages[0].commands.length)throw Error('Matched compiler results were not retained');
        await page.locator('[data-phase=game]').click();
        if(await page.locator('#cancel').isEnabled() || await page.locator('[data-phase=game] time').textContent()!==gameTime)throw Error('Reviewing the game started a rebuild');
        await page.locator('#game-play').click();
        await page.locator('#game-close').click();
        if(await page.evaluate(()=>window.gamePlaying))throw Error('Closing during startup left the game running');
        await page.locator('#game-play').click();
        await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:90000});
        if(await page.evaluate(()=>window.gameError))throw Error(await page.evaluate(()=>window.gameError));
        await page.locator('#game-close').click();
        report.maxConcurrentUnits=await page.evaluate(()=>window.maxConcurrentUnits);
        if(report.maxConcurrentUnits<Math.min(2,report.inception.workerCount))throw Error('Compile workers did not overlap');
      }
      clearInterval(progressTimer);
      report.workflowTime=await page.locator('#workflow-time').textContent();
      report.phases=await page.locator('[data-phase]').evaluateAll(buttons=>buttons.map(b=>({phase:b.dataset.phase,
        state:b.parentElement.className,time:b.querySelector('time').textContent,processed:b.querySelector('.node-stats span').textContent})));
      if(mode==='roundtrip')report.inception=await page.evaluate(()=>window.lastInceptionEvent);
      await page.screenshot({path:path.join(out,'site-workflow.png'),fullPage:true});
    }
    if(requests.some(r=>!['GET','HEAD'].includes(r.method)))throw Error('Build sent data to the server');
    report.staticRequestsOnly=true;
    if(errors.length)throw Error('Page produced JavaScript errors');
    report.passed=true;console.log(`PASS: ${mode} browser journey`);
  }finally{
    clearInterval(progressTimer);
    report.requests=requests;
    fs.writeFileSync(path.join(out,`site-${mode}-results.json`),JSON.stringify(report,null,2)+'\n');
    if(process.env.DEMO_TEST_TRACE)await browser.contexts()[0]?.tracing.stop({path:path.join(out,'trace.zip')});
    await browser.close();server.close();
  }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
