// Recheck runtime changes using saved, hash-verified browser compilation outputs.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{chromium}=require('playwright');
const root=path.resolve(process.argv[2]||'dist'),target=process.argv[3]||'godot',built=path.resolve(process.argv[4]||'build/project-results'),out=path.resolve(process.argv[5]||built);
fs.mkdirSync(out,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'projects',target,'manifest.json'))),compiled=JSON.parse(fs.readFileSync(path.join(built,target+'-compiled-manifest.json'))),report=JSON.parse(fs.readFileSync(path.join(built,target+'-compiled-report.json')));
const contract=({player,...source})=>source;assert.deepEqual(contract(manifest),contract(compiled),'compiler inputs changed; rebuild before testing the player');
for(const compiler of ['cppgm','clang'])assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(built,`browser-${target}-${compiler}.wasm`))).digest('hex'),report[compiler].sha256,'saved browser output changed');
const server=http.createServer((req,res)=>{
 const route=req.url.split('?')[0];let file=path.resolve(root,'.'+decodeURIComponent(route));
 const fixture=route.match(/^\/qualified\/(cppgm|clang)\.wasm$/);if(fixture)file=path.join(built,`browser-${target}-${fixture[1]}.wasm`);else if(!file.startsWith(root+'/'))return res.writeHead(403).end();
 for(const [name,value]of Object.entries({'Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}))res.setHeader(name,value);
 res.setHeader('Content-Type',({'.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream');
 const stream=fs.createReadStream(file);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--site-per-process']});
 try{
  for(const compiler of ['cppgm','clang']){
  const page=await browser.newPage({viewport:{width:1379,height:994},deviceScaleFactor:2}),errors=[];page.setDefaultTimeout(180000);
  if (target === 'godot') {
    // Headless Chromium can emulate the top-level viewport without changing
    // DPI and screen dimensions inside its cross-origin player frame.
    await page.addInitScript(() => {
      if (window === top) return;
      Object.defineProperty(window, 'devicePixelRatio', {value: 2});
      Object.defineProperty(screen, 'width', {value: 1800});
      Object.defineProperty(screen, 'height', {value: 1169});
    });
  }
  page.on('pageerror',error=>{errors.push(String(error));console.error(error.stack);});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
   async function start(){
    await page.evaluate(async({target,compiler,port})=>{
     const {PlayerSession}=await import('./player_session.mjs');
     const manifest=await fetch(`projects/${target}/manifest.json`).then(r=>r.json()),game=new Uint8Array(await fetch(`/qualified/${compiler}.wasm`).then(r=>r.arrayBuffer()));
     const modal=document.getElementById('game-modal'),surface=document.getElementById('game-surface');modal.dataset.project=target;document.getElementById('game-modal-title').textContent=target+' · built in your browser';if(target==='godot')document.getElementById('game-help').textContent='Create or open a project in the editor. Close to return to the build.';if(!modal.open)modal.showModal();
     window.openLaraGame=new PlayerSession(surface,{url:`http://localhost:${port}/game_frame.html`,log:message=>{document.getElementById('log').textContent+=message+'\n';}});
     await window.openLaraGame.start({game,project:target,player:{...manifest.player,baseURL:new URL(`projects/${target}/`,location.href).href}});
    },{target,compiler,port:server.address().port});
    await page.waitForFunction(()=>window.openLaraGame.drawCalls>3);
    await assertFits();
   }
   async function assertFits(){
    if(target!=='godot')return;
    const geometry=await page.evaluate(()=>{const m=document.getElementById('game-modal'),f=document.getElementById('game-frame'),r=m.getBoundingClientRect(),b=f.getBoundingClientRect(),c=document.getElementById('game-close').getBoundingClientRect();return{inside:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,scroll:m.scrollTop,overflow:m.scrollHeight>m.clientHeight,close:c.top>=r.top&&c.bottom<=r.bottom,ratio:b.width/b.height};});
    assert(geometry.inside&&geometry.close&&!geometry.overflow,'Editor clipped: '+JSON.stringify(geometry));
    assert.equal(geometry.scroll,0,'Focusing editor scrolled its modal');
    assert(Math.abs(geometry.ratio-1.6)<0.01,'Editor aspect ratio changed');
    const canvas=await page.frameLocator('#game-frame').locator('#canvas').evaluate(c=>{const r=c.getBoundingClientRect();return{inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,size:[c.width,c.height],dpr:devicePixelRatio};});
    assert(canvas.inside,'Canvas clipped inside iframe: '+JSON.stringify(canvas));assert.deepEqual(canvas.size,[1280,800]);
    assert.equal(canvas.dpr,2,'Godot player did not run with the Retina display metrics');
   }
   console.log('Starting',compiler);await start();console.log('Started',compiler);
   if(target==='godot'){
    await require('./godot_editor_journey.cjs').openImport(page,compiler,out);await assertFits();
    await require('./godot_editor_journey.cjs').openCreate(page);await assertFits();
    await page.evaluate(()=>window.openLaraGame.close());await page.waitForTimeout(250);
    console.log('Starting fresh manager',compiler);await start();console.log('Creating project',compiler);await require('./godot_editor_journey.cjs').createProject(page,compiler,out,{center:true});
    for(const viewport of [{width:1440,height:1000},{width:1280,height:720},{width:1024,height:640},{width:390,height:844}]){await page.setViewportSize(viewport);await page.waitForTimeout(300);await assertFits();await page.screenshot({path:path.join(out,`godot-${compiler}-${viewport.width}.png`)});}
    await page.setViewportSize({width:1280,height:720});await assertFits();
   }
   await page.evaluate(()=>window.openLaraGame.close());await page.waitForTimeout(250);assert.deepEqual(errors,[]);
   await page.close();
   console.log('PASS:',target,compiler,target==='godot'?'browser-built module, import/create clicks, editor restart and fitted viewport':'browser-built module opens and closes');
  }
  fs.writeFileSync(path.join(out,target+'-players-report.json'),JSON.stringify({passed:true,sourceContractUnchanged:true,cppgm:report.cppgm.sha256,clang:report.clang.sha256},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
