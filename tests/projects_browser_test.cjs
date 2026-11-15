// Real browser compilation/linking of every application and supporting unit.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const root=path.resolve(process.argv[2]||'dist'),targets=(process.argv[3]||'all')==='all'?['lara','doom','godot']:[process.argv[3]],out=path.resolve(process.argv[4]||'build/project-results');
fs.mkdirSync(out,{recursive:true});
const requests=[],server=http.createServer((req,res)=>{
 requests.push({method:req.method,url:req.url});const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
 if(!file.startsWith(root+'/'))return res.writeHead(403).end();
 for(const [name,value]of Object.entries({'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}))res.setHeader(name,value);
 res.setHeader('Content-Type',({'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
 const stream=fs.createReadStream(file);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--site-per-process']});
 try{for(const target of targets){
  const touch=process.env.GAME_TEST_TOUCH==='1'&&target==='lara';
  const page=await browser.newPage({viewport:touch?{width:390,height:844}:{width:1440,height:1000},hasTouch:touch,isMobile:touch}),errors=[];let timer;
  page.setDefaultTimeout(180000);page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE',String(e));});
  page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,600));});
  await page.addInitScript(url=>window.incpptionPlayerURL=url,`http://localhost:${server.address().port}/game_frame.html`);
  try{
   await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
   await page.waitForFunction(()=>window.lastProjectEvent?.kind==='source'&&!document.getElementById('run-workflow').disabled);
   assert.equal(await page.locator('#build-target').inputValue(),'doom');
   await page.locator('#build-target').selectOption(target);
   const manifest=JSON.parse(fs.readFileSync(path.join(root,'projects',target,'manifest.json'))),units=manifest.commands.length+manifest.archives.length+1;
   await page.locator('[data-phase=game]').click();
   timer=setInterval(async()=>{try{const status=await page.evaluate(()=>({event:window.lastWorkflowEvent?.kind,phase:window.lastWorkflowEvent?.phase,status:document.getElementById('status').textContent,cppgm:document.getElementById('completed').textContent,clang:document.getElementById('completed-clang').textContent,time:document.getElementById('workflow-time').textContent}));console.log(target,JSON.stringify(status));fs.appendFileSync(path.join(out,target+'-progress.jsonl'),JSON.stringify(status)+'\n');}catch{}},15000);
   await page.waitForFunction(()=>window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind==='complete',null,{timeout:target==='godot'?10800000:5400000});
   assert.notEqual(await page.evaluate(()=>window.lastWorkflowEvent?.kind),'error',await page.evaluate(()=>window.lastWorkflowEvent?.error));
   clearInterval(timer);
   assert.equal(await page.locator('#units .done').count(),units);assert.equal(await page.locator('#units-clang .done').count(),units);
   const report=await page.evaluate(()=>({cppgm:window.lastGameBuild,clang:window.lastClangGameBuild}));report.units=units;report.supportSources=manifest.commands.filter(row=>row.category==='support').length;
   assert(report.supportSources>0);assert.equal(report.cppgm.sha256,manifest.link.sha256);
   for(const [button,compiler]of [['game-play','cppgm'],['game-play-clang','clang']]){
    console.log(target,'playing',compiler);await page.locator('#'+button).click();
    await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:300000});
    assert.equal(await page.evaluate(()=>window.gameError),undefined);
    await page.waitForFunction(minimum=>window.openLaraGame?.drawCalls>minimum,target==='godot'?3:100,{timeout:180000});
    if(touch){
      const frame=page.frameLocator('#game-frame');await frame.locator('.game-controls').scrollIntoViewIfNeeded();
      const cdp=await page.context().newCDPSession(page);
      const point=async(name,id)=>{const b=await frame.locator(`[data-control=${name}]`).boundingBox();return{x:b.x+b.width/2,y:b.y+b.height/2,id};};
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[await point('up',1),await point('jump',2)]});
      assert.equal(await frame.locator('[aria-pressed=true]').count(),2);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal(await frame.locator('[aria-pressed=true]').count(),0);await cdp.detach();
    }
    await page.evaluate(()=>window.openLaraGame.pause());await page.screenshot({path:path.join(out,target+'-'+compiler+'.png'),fullPage:true});await page.evaluate(()=>window.openLaraGame.resume());
    await page.locator('#game-close').click();assert.equal(await page.evaluate(()=>window.gamePlaying),false);
   }
   await page.screenshot({path:path.join(out,target+'-built.png'),fullPage:true});assert.deepEqual(errors,[]);
   assert(requests.every(row=>['GET','HEAD'].includes(row.method)));
   report.passed=true;fs.writeFileSync(path.join(out,target+'-report.json'),JSON.stringify(report,null,2));console.log('PASS:',target,units,'browser-built units; both outputs run');
  }finally{clearInterval(timer);await page.close();}
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
