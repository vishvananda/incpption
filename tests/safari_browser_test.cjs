// Exercise the compiler in WebKit with the stale headers observed on production.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{webkit}=require('playwright');
const root=path.resolve(process.argv[2]||'dist'),out=path.resolve(process.argv[3]||(process.env.SAFARI_TEST_MOBILE?'build/safari-mobile-results':'build/safari-results')),origin=process.env.SAFARI_TEST_ORIGIN,mobile=!!process.env.SAFARI_TEST_MOBILE;
const reusable=!!JSON.parse(fs.readFileSync(path.join(root,'compiler/manifest.json'))).process_reset;
fs.mkdirSync(out,{recursive:true});
const headerRules=fs.readFileSync(path.join(root,'_headers'),'utf8').trim().split(/\n\s*\n/).map(block=>{
 const [pattern,...lines]=block.split('\n');
 const expression=pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
 return {pattern:new RegExp('^'+expression+'$'),headers:lines.map(line=>{const colon=line.indexOf(':');return [line.slice(0,colon).trim(),line.slice(colon+1).trim()];})};
});
const requests=[],server=http.createServer((req,res)=>{
 const route=req.url.split('?')[0],file=path.resolve(root,'.'+decodeURIComponent(route));requests.push(route);
 if(!file.startsWith(root+'/'))return res.writeHead(403).end();
 for(const rule of headerRules)if(rule.pattern.test(route))for(const [name,value]of rule.headers)res.setHeader(name,value);
 if(route.startsWith('/shim/')){res.removeHeader('Cross-Origin-Opener-Policy');res.removeHeader('Cross-Origin-Embedder-Policy');}
 // Pages adds CORS to static assets; the separate player adds CORP globally.
 if(req.headers.host.startsWith('localhost:'))res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
 const stream=fs.createReadStream(file);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await webkit.launch({headless:true});
 try{
  const page=await browser.newPage(mobile?{viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:require('playwright').devices['iPhone 13'].userAgent}:{viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(180000);
  page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE',String(e));});
  page.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text().slice(0,1000));});
  await page.addInitScript(()=>{const resume=AudioContext.prototype.resume;AudioContext.prototype.resume=function(...args){window.testAudioContext=this;if(navigator.userActivation?.isActive)window.testAudioGesture=true;return resume.apply(this,args);};});
  if(!origin)await page.addInitScript(url=>window.incpptionPlayerURL=url,`http://localhost:${server.address().port}/game_frame.html`);
  await page.goto((origin||`http://127.0.0.1:${server.address().port}`)+'/index.html');
  await page.waitForFunction(()=>!document.getElementById('run-workflow').disabled&&window.lastProjectEvent?.kind==='source');
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true,'page is not isolated with the deployed header rules');
  const diagnostic=await page.evaluate(async()=>{
    // An invalid module tests the actual worker's Safari error reporting.
    const worker=new Worker('./compile_worker.mjs',{type:'module'}),channel=new MessageChannel();
    const receive=()=>new Promise(resolve=>channel.port2.onmessage=({data})=>resolve(data));
    try{
      worker.postMessage({port:channel.port1},[channel.port1]);
      let result=receive();channel.port2.postMessage({kind:'init',layers:[],module:await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]))});await result;
      result=receive();channel.port2.postMessage({kind:'compile',args:[],source:'ashrti3.c',output:'build/obj/test.o'});
      return await result;
    }finally{channel.port2.close();worker.terminate();}
  });
  assert.equal(diagnostic.kind,'error');assert.match(diagnostic.error,/ashrti3\.c:/);
  assert.match(diagnostic.error,/(TypeError|Error): .+/,'Safari lost the exception message');
  await page.locator('#worker-choice').selectOption(process.env.SAFARI_TEST_WORKERS||(mobile?'2':'8'),{force:true});
  await page.locator('#build-target').selectOption('lara');
  await page.locator('[data-phase=game]').click();
  const timer=setInterval(async()=>{try{console.log(JSON.stringify(await page.evaluate(()=>({status:document.getElementById('status').textContent,cppgm:document.getElementById('completed').textContent,clang:document.getElementById('completed-clang').textContent}))));}catch{}},15000);
  try{await page.waitForFunction(()=>window.lastWorkflowEvent?.kind==='error'||window.lastGameBuild?.kind==='complete'&&window.lastClangGameBuild?.kind==='complete',null,{timeout:900000});}finally{clearInterval(timer);}
  const report=await page.evaluate(()=>{const summary=({player,...data}={})=>data;return {cppgm:summary(window.lastGameBuild),clang:summary(window.lastClangGameBuild),status:document.getElementById('status').textContent,error:window.lastWorkflowEvent?.error,ua:navigator.userAgent};});
  console.log(JSON.stringify(report));assert.equal(report.cppgm.kind,'complete',report.error);assert.equal(report.clang.kind,'complete',report.error);
  assert.equal(await page.locator('#comparison-result').isVisible(),true);
  if(mobile)for(const [lane,row] of Object.entries({cppgm:report.cppgm,clang:report.clang})){
    assert.equal(row.deferredLinker,true,'linker shares the compiler realm');
    if(lane==='clang'||reusable)assert.equal(row.retiredWorkers,row.workerCount,'resettable compilers recreated workers');
    else assert(row.retiredWorkers>=290,'compile heaps survived between files');
    assert.equal(row.workerCount,Number(process.env.SAFARI_TEST_WORKERS||2)/2);
  }
  for(const button of ['game-play','game-play-clang']){
   await page.locator('#'+button).click();
   await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:180000});
   assert.equal(await page.evaluate(()=>window.gameError),undefined);
   const frame=page.frameLocator('#game-frame');await frame.locator('#canvas').click();
   // Headless Linux may have no audio device. Verify startup and a resume
   // attempt during a trusted gesture, without requiring audio hardware.
   const gameFrame=await(await page.locator('#game-frame').elementHandle()).contentFrame();
   await gameFrame.waitForFunction(()=>window.testAudioContext?.state==='running'||window.testAudioGesture===true);
   await page.screenshot({path:path.join(out,button+'.png'),fullPage:true});
   await page.locator('#game-close').click();assert.equal(await page.evaluate(()=>window.gamePlaying),false);
  }
  assert.deepEqual(errors,[]);
  if(!origin){assert(!requests.some(p=>p.startsWith('/shim/')),'compiler imported the stale shim URL');assert(requests.some(p=>p.startsWith('/runtime-shim.')),'compiler did not load its versioned shim');}
  await page.locator('#rerun-phase').click();await page.locator('#cancel').click();assert.equal(await page.locator('#cancel').isEnabled(),false);
  await page.locator('[data-journey=inception]').click();
  await page.locator('[data-phase=match]').click();
  const selfProgress=setInterval(()=>page.evaluate(()=>({status:document.getElementById('status')?.textContent,files:document.getElementById('completed')?.textContent,event:window.lastInceptionEvent,workflow:window.lastWorkflowEvent})).then(value=>{
   fs.writeFileSync(path.join(out,'self-build-progress.json'),JSON.stringify(value,null,2));console.log('self-build',JSON.stringify(value));
  }).catch(()=>{}),15000);
  try{await page.waitForFunction(()=>window.lastInceptionEvent?.kind==='complete'||window.lastWorkflowEvent?.kind==='error',null,{timeout:900000});}
  finally{clearInterval(selfProgress);}
  report.inception=await page.evaluate(()=>window.lastInceptionEvent);
  assert.equal(report.inception.kind,'complete',report.inception.error);
  if(mobile){assert.equal(report.inception.workerCount,Number(process.env.SAFARI_TEST_WORKERS||2));
    if(reusable)assert(report.inception.retiredWorkers<=report.inception.workerCount+1,'self-build recreated resettable workers');
    else assert(report.inception.retiredWorkers>=469,'self-build retained compiler heaps');}
  await page.locator('[data-phase=game]').click();
  await page.waitForFunction(()=>window.lastGameBuild?.kind==='complete'||window.lastWorkflowEvent?.kind==='error',null,{timeout:300000});
  assert.equal(await page.evaluate(()=>window.lastGameBuild.kind),'complete');
  await page.locator('#game-play').click();
  await page.waitForFunction(()=>window.gamePlaying||window.gameError,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>window.gameError),undefined);
  await page.locator('#game-close').click();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,passed:true},null,2));
  console.log('PASS: WebKit compiles and links with both compilers, plays both outputs, cancels and reproduces the self-built compiler');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
