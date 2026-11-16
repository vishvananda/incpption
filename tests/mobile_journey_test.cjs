#!/usr/bin/env node
const fs=require('fs'),path=require('path'),http=require('http');
const pw=require('playwright'),root=path.resolve(process.argv[2]||'dist'),out=path.resolve(process.argv[3]||'build/mobile-journey');
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
  if(!file.startsWith(root+'/')){res.writeHead(403).end();return;}
  res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'})[ext]||'application/octet-stream');
  res.setHeader('Access-Control-Allow-Origin','*');
  const stream=fs.createReadStream(file);stream.on('error',()=>{res.writeHead(404).end();});stream.pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/wasi_demo.html`;
  for(const name of ['chromium','webkit']){
    const browser=await pw[name].launch({headless:true,...(name==='chromium'?{args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--site-per-process']}:{})});
    try{
      const context=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844},userAgent:pw.devices['iPhone 13'].userAgent}),page=await context.newPage(),errors=[];
      page.setDefaultTimeout(120000);
      page.on('pageerror',error=>errors.push(String(error)));
      await page.addInitScript(url=>window.incpptionPlayerURL=url,`http://localhost:${server.address().port}/game_frame.html`);
      await page.goto(url);await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source');
      for(const width of [320,390,430]){
        await page.setViewportSize({width,height:844});
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`${name} overflow at ${width}`);
        await page.waitForFunction(()=>[...document.querySelectorAll('.units')].every(e=>e.getBoundingClientRect().height<=240));
        if(!await page.locator('.project-files').evaluate(e=>e.open))throw Error('File browser is collapsed by default');
        if(!await page.locator('#source-files button[aria-selected]').first().isVisible())throw Error('Source files are hidden');
        await page.screenshot({path:path.join(out,`${name}-${width}.png`),fullPage:true});
      }
      for (const journey of ['inception','roundtrip','game']) {
        await page.locator(`.journey-nav [data-journey=${journey}]`).click();
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`${name} ${journey} flow overflows`);
        if(await page.locator('#explorer').evaluate(e=>e.parentElement.tagName)!=='MAIN')throw Error('File browser moved between phases');
        await page.screenshot({path:path.join(out,`${name}-${journey}.png`),fullPage:true});
      }
      if(name==='chromium'&&!process.env.MOBILE_TEST_LAYOUT_ONLY){
        await page.locator('#build-target').selectOption('lara');
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-phase=game]').click();
        await page.waitForFunction(()=>{
          const toolbar=document.querySelector('.workflow-toolbar').getBoundingClientRect(),heading=document.querySelector('.phase-heading').getBoundingClientRect();
          return toolbar.top>=-1&&heading.top>=toolbar.bottom&&heading.bottom<innerHeight;
        });
        await page.waitForFunction(()=>document.getElementById('completion-modal').open||window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind==='complete',null,{timeout:600000});
        const playEarly=await page.locator('#completion-modal').isVisible();
        if(playEarly){
          await page.locator('#completion-play').click();
          await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:90000});
          if(await page.locator('#completion-modal').isVisible())throw Error('Play now kept the completion prompt open');
        }
        await page.waitForFunction(early=>window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind===(early?'cancelled':'complete'),playEarly,{timeout:600000});
        if(playEarly&&page.workers().length)throw Error('Compiler workers survived Play now');
        const built=await page.evaluate(()=>window.lastGameBuild);if(built.kind!=='complete')throw Error(built.error);
        const reusable=!!JSON.parse(fs.readFileSync(path.join(root,'compiler/manifest.json'))).process_reset;
        if(built.workerCount!==1||!built.deferredLinker||(reusable?built.retiredWorkers!==1:built.retiredWorkers<290))throw Error('Phone did not bound worker memory');
        if(!await page.locator('#game-modal').isVisible())await page.locator('#game-play').click();
        await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:90000});
        if(await page.evaluate(()=>window.gameError))throw Error(await page.evaluate(()=>window.gameError));
        const frame=page.frameLocator('#game-frame');
        await frame.locator('.game-controls').scrollIntoViewIfNeeded();
        const cdp=await context.newCDPSession(page);
        const point=async(name,id)=>{const b=await frame.locator(`[data-control=${name}]`).boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2,id};};
        const up=await point('up',1),jump=await point('jump',2);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[up,jump]});
        if(await frame.locator('[aria-pressed=true]').count()!==2)throw Error('Phone controls did not combine movement and jump');
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        if(await frame.locator('[aria-pressed=true]').count())throw Error('Phone controls remained pressed');
        await page.waitForFunction(()=>window.openLaraGame?.drawCalls>150,null,{timeout:60000});
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Phone game overflows');
        await page.screenshot({path:path.join(out,'chromium-game.png'),fullPage:true});
        await page.locator('#game-close').click();
        if(await page.evaluate(()=>window.gamePlaying))throw Error('Leaving the game did not stop it');
      }
      if(errors.length)throw Error(errors.join('\n'));
      console.log(`PASS: ${name} phone layout and ${name==='chromium'&&!process.env.MOBILE_TEST_LAYOUT_ONLY?'real game with multi-touch':'source browser'}`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
