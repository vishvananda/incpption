const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
const root=path.resolve(process.argv[2]||'dist'),out=path.resolve(process.argv[3]||'build/comparison-results');
fs.mkdirSync(out,{recursive:true});
const methods=[],requests=[],server=http.createServer((req,res)=>{
  methods.push(req.method);requests.push(req.url);const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
  if(!file.startsWith(root+'/')){res.writeHead(403).end();return;}
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Content-Type',({'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin','*');
  const stream=fs.createReadStream(file);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--site-per-process']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],workers=new Set();
    page.setDefaultTimeout(120000);page.on('pageerror',e=>errors.push(String(e)));
    page.on('worker',w=>{workers.add(w);w.on('close',()=>workers.delete(w));});
    await page.addInitScript(url=>window.incpptionPlayerURL=url,`http://localhost:${server.address().port}/game_frame.html`);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source'&&!document.getElementById('run-workflow').disabled);
    const project=JSON.parse(fs.readFileSync(path.join(root,'projects/lara/manifest.json')));
    assert(Number.isSafeInteger(project.source_date_epoch),'project references must pin __DATE__ and __TIME__');
    assert.equal(await page.title(),'cppgm inception');
    assert.equal(await page.locator('[data-journey=game] strong').textContent(),'compilation');
    assert.equal(await page.locator('.route-vs').count(),0);
    assert.equal(await page.locator('#flow .node-download').textContent(),await page.locator('#flow-clang .node-download').textContent(),'project inputs must be identical');
    assert.notEqual(await page.locator('#flow .setup-download').textContent(),await page.locator('#flow-clang .setup-download').textContent(),'compiler setup belongs at the seed');
    assert.equal(await page.locator('.header-actions a').getAttribute('href'),'https://github.com/vishvananda/incpption');
    assert.equal(await page.locator('[data-flow-size=game] .download-total').textContent(),(()=>{const p=JSON.parse(fs.readFileSync(path.join(root,'download-plan.json')));return([...new Set([...p.targets.lara.stages.game,...p.targets.lara.stages['game-clang'],...p.targets.lara.playFiles])].reduce((n,f)=>n+p.files[f],0)/1048576).toFixed(1)+' MiB total';})());
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
      const layout=await page.evaluate(()=>{
        const a=document.getElementById('flow').getBoundingClientRect(),b=document.getElementById('flow-clang').getBoundingClientRect();
        const c=document.querySelector('.phase-grid').getBoundingClientRect(),d=document.getElementById('clang-results').getBoundingClientRect();
        return {flows:a.right<=b.left&&Math.abs(a.top-b.top)<2,grids:c.right<=d.left&&Math.abs(c.top-d.top)<2};
      });assert(layout.flows&&layout.grids,'comparison is not side by side');
      await page.screenshot({path:path.join(out,`layout-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#journey-game').focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#journey-inception').getAttribute('aria-selected'),'true');
    await page.keyboard.press('Home');assert.equal(await page.locator('#journey-game').getAttribute('aria-selected'),'true');
    const logo=page.locator('.logo-title .wordmark');
    await logo.click();assert.equal(await logo.evaluate(e=>e.getAnimations({subtree:true}).length),3);
    await page.waitForTimeout(2100);
    await page.emulateMedia({reducedMotion:'reduce'});await logo.click();assert.equal(await logo.evaluate(e=>e.getAnimations({subtree:true}).length),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    for(const target of ['doom','godot','lara']){
      await page.locator('#build-target').selectOption(target);
      assert.equal(await page.locator('[data-phase=game] .node-name').textContent(),target==='doom'?'Doom 3':target==='godot'?'Godot':'OpenLara');
      assert.equal(await page.locator('#run-workflow').isEnabled(),true);
      if(target==='doom'){
        assert.match(await page.locator('[data-flow-size=game] .download-data').textContent(),/458\.3 MiB game data/);
        assert.match(await page.locator('#game-data-download').textContent(),/458\.3 MiB/);
      }
      if(target==='godot')assert.match(await page.locator('#target-note').textContent(),/Long build/);
    }
    const m=JSON.parse(fs.readFileSync(path.join(root,'projects/lara/manifest.json'))),units=m.commands.length+m.archives.length+1;
    await page.locator('[data-phase=game]').click();
    assert.equal(await page.locator('#cancel').isEnabled(),true);
    assert.equal(await page.locator('#flow-rows .flow-node.active').count(),2);
    await page.waitForFunction(()=>document.getElementById('build-grids').getBoundingClientRect().bottom<=innerHeight);
    await page.waitForFunction(()=>window.lastGameDataDownload?.project==='lara'&&window.lastGameDataDownload.loaded>0);
    assert.equal(await page.locator('#cancel').isEnabled(),true,'game data did not preload during compilation');
    await page.waitForFunction(()=>document.getElementById('completion-modal').open||window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind==='complete',null,{timeout:600000});
    if(await page.locator('#completion-modal').isVisible()){
      assert.equal(await page.locator('#cancel').isEnabled(),true,'Clang stopped at the completion prompt');
      await page.screenshot({path:path.join(out,'cppgm-complete.png')});
      await page.locator('#completion-wait').click();
    }
    await page.waitForFunction(()=>window.lastGameBuild?.kind==='error'||window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind==='complete',null,{timeout:600000});
    const report=await page.evaluate(()=>({cppgm:window.lastGameBuild,clang:window.lastClangGameBuild,error:window.lastWorkflowEvent?.kind==='error'?window.lastWorkflowEvent.error:null}));
    assert.equal(report.error,null);assert.equal(report.cppgm.kind,'complete');assert.equal(report.clang.kind,'complete');
    assert.equal(report.cppgm.workerCount,report.clang.workerCount);
    try{
      // The player allows five minutes for cold Wasm/graphics startup. Let it
      // report its own error before the test deadline, including on CI software GL.
      await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:330000});
      assert.equal(await page.evaluate(()=>window.gameError),undefined);
    }catch(error){
      const startup=await page.evaluate(()=>({status:document.getElementById('game-status').textContent,modal:document.getElementById('game-modal').open,playing:window.gamePlaying,error:window.gameError,log:document.getElementById('log').textContent}));
      fs.writeFileSync(path.join(out,'player-start-failure.json'),JSON.stringify(startup,null,2));throw error;
    }
    assert.equal(await page.locator('#completion-modal').isVisible(),false);
    await page.locator('#game-close').click();
    assert.equal(await page.locator('#comparison-result').isVisible(),true);
    const ratio=Math.max(report.cppgm.compileSeconds,report.clang.compileSeconds)/Math.min(report.cppgm.compileSeconds,report.clang.compileSeconds);
    assert.equal(await page.locator('#comparison-result>strong').textContent(),ratio.toFixed(2)+'×');
    await page.waitForFunction(()=>window.lastGameDataDownload?.done);
    const assetRequests=requests.filter(url=>url.includes('/projects/lara/assets/'));
    assert.equal(assetRequests.length,m.player.assets.reduce((n,a)=>n+a.chunks.length,0),'preload did not fetch each game chunk once');
    assert.equal(await page.locator('#units .done').count(),units);assert.equal(await page.locator('#units-clang .done').count(),units);
    for(const id of ['game','game-clang']){
      const before=await page.locator(`[data-phase="${id}"] time`).textContent();
      await page.locator(`[data-phase="${id}"]`).click();await page.waitForTimeout(300);
      assert.equal(await page.locator(`[data-phase="${id}"] time`).textContent(),before);
      assert.equal(await page.locator('#cancel').isEnabled(),false,'reviewing a result started a build');
    }
    await page.locator('.journey-nav [data-journey=inception]').click();
    assert.equal(await page.locator('#comparison-result').isVisible(),false,'another workflow showed the comparison result');
    await page.locator('.journey-nav [data-journey=game]').click();
    assert.equal(await page.locator('#comparison-result').isVisible(),true,'cached comparison lost its speedup');
    assert.equal(await page.locator('#units .done').count(),units,'changing workflows lost results');
    await page.locator('#build-target').selectOption('godot');await page.locator('#build-target').selectOption('lara');
    assert.equal(await page.locator('#units .done').count(),units,'changing targets lost results');
    for(const url of new Set(requests.filter(url=>/\/(projects\/lara\/chunks\/|compiler\/inputs\/w1\/cppgm\.wasm)/.test(url))))assert.equal(requests.filter(value=>value===url).length,1,'comparison downloaded a shared input twice: '+url);
    for(const compiler of ['cppgm','clang']) {
      const bytes=await page.locator(`#downloads a[download="lara-${compiler}.wasm"]`).evaluate(async a=>Array.from(new Uint8Array(await(await fetch(a.href)).arrayBuffer())));
      fs.writeFileSync(path.join(out,compiler+'.wasm'),Buffer.from(bytes));
      const names=WebAssembly.Module.exports(new WebAssembly.Module(Buffer.from(bytes))).map(e=>e.name);
      assert(names.includes('main')||names.includes('__main_argc_argv'),'the linked game has no exported entry point');
    }
    for(const id of ['game-play','game-play-clang']){

      await page.locator('#'+id).click();
      await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:120000});
      assert.equal(await page.evaluate(()=>window.gameError),undefined);
      await page.waitForFunction(()=>window.openLaraGame?.drawCalls>100,null,{timeout:90000});
      await page.locator('#game-close').click();assert.equal(await page.evaluate(()=>window.gamePlaying),false);
    }
    assert.equal(requests.filter(url=>url.includes('/projects/lara/assets/')).length,assetRequests.length,'Play downloaded preloaded game data again');
    await page.screenshot({path:path.join(out,'comparison-built.png'),fullPage:true});
    for(const width of [320,390,768,1440]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`completed comparison overflow at ${width}`);
      await page.screenshot({path:path.join(out,`built-${width}.png`),fullPage:true});
    }
    await page.locator('#rerun-phase').click();assert.equal(await page.locator('#cancel').isEnabled(),true);
    assert.equal(await page.locator('#comparison-result').isVisible(),false,'rerun kept a stale speedup');
    await page.locator('#cancel').click();
    await page.waitForFunction(()=>document.getElementById('cancel').disabled);
    for(let n=0;workers.size&&n<100;n++)await page.waitForTimeout(100);
    assert.equal(workers.size,0,'build workers survived cancellation');
    const time=await page.locator('#elapsed-clang').textContent();await page.waitForTimeout(1100);assert.equal(await page.locator('#elapsed-clang').textContent(),time,'cancelled timer kept running');
    assert.equal(await page.locator('#game-play').isEnabled(),false,'rerun kept stale playable output');
    assert.deepEqual(errors,[]);assert(methods.every(m=>['GET','HEAD'].includes(m)));
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,passed:true},null,2));
    console.log(`PASS: simultaneous cppgm/Clang builds, both playable outputs, result retention, explicit rerun, download estimates and responsive logo`);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
