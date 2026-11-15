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
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(180000);
  page.on('pageerror',error=>{errors.push(String(error));console.error(error.stack);});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  for(const compiler of ['cppgm','clang']){
   async function start(){
    await page.evaluate(async({target,compiler,port})=>{
     const {PlayerSession}=await import('./player_session.mjs');
     const manifest=await fetch(`projects/${target}/manifest.json`).then(r=>r.json()),game=new Uint8Array(await fetch(`/qualified/${compiler}.wasm`).then(r=>r.arrayBuffer()));
     const surface=document.createElement('div');surface.className='game-surface';surface.style.cssText='width:1280px;margin:auto';document.body.prepend(surface);
     window.openLaraGame=new PlayerSession(surface,{url:`http://localhost:${port}/game_frame.html`,log:message=>{document.getElementById('log').textContent+=message+'\n';}});
     await window.openLaraGame.start({game,project:target,player:{...manifest.player,baseURL:new URL(`projects/${target}/`,location.href).href}});
    },{target,compiler,port:server.address().port});
    await page.waitForFunction(()=>window.openLaraGame.drawCalls>3);
   }
   await start();
   if(target==='godot'){
    await require('./godot_editor_journey.cjs').openCreate(page);
    await page.evaluate(()=>window.openLaraGame.close());await page.waitForTimeout(250);
    await start();await require('./godot_editor_journey.cjs').createProject(page,compiler,out);
   }
   await page.evaluate(()=>window.openLaraGame.close());await page.waitForTimeout(250);assert.deepEqual(errors,[]);
   console.log('PASS:',target,compiler,'browser-built module, editor restart and focused-dialog close');
  }
  fs.writeFileSync(path.join(out,target+'-players-report.json'),JSON.stringify({passed:true,sourceContractUnchanged:true,cppgm:report.cppgm.sha256,clang:report.clang.sha256},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
