#!/usr/bin/env node
const fs=require('fs'),path=require('path'),http=require('http');
const pw=require('playwright'),root=path.resolve(process.argv[2]||'dist'),out=path.resolve(process.argv[3]||'build/mobile-journey');
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
  if(!file.startsWith(root+'/')){res.writeHead(403).end();return;}
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  const ext=path.extname(file);res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'})[ext]||'application/octet-stream');
  const stream=fs.createReadStream(file);stream.on('error',()=>{res.writeHead(404).end();});stream.pipe(res);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/wasi_demo.html`;
  for(const name of ['chromium','webkit']){
    const browser=await pw[name].launch({headless:true,...(name==='chromium'?{args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']}:{})});
    try{
      const context=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(String(error)));
      await page.goto(url);await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source');
      for(const width of [320,390,430]){
        await page.setViewportSize({width,height:844});
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`${name} overflow at ${width}`);
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
      if(name==='chromium'){
        await page.setViewportSize({width:390,height:844});
        await page.locator('[data-phase=game]').click();
        await page.waitForFunction(()=>['complete','error'].includes(window.lastGameBuild?.kind),null,{timeout:300000});
        const built=await page.evaluate(()=>window.lastGameBuild);if(built.kind!=='complete')throw Error(built.error);
        await page.locator('#game-play').click();
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
      console.log(`PASS: ${name} phone layout and ${name==='chromium'?'real game with multi-touch':'source browser'}`);
    }finally{await browser.close();}
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
