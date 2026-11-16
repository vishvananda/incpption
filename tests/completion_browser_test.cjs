// Control completion order at the build/player boundary; exercise the real page,
// dialogs and callbacks without compiling an entire game for every race.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium,webkit}=require('playwright');
const root=path.resolve(process.argv[2]||'dist');
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
 if(!file.startsWith(root+'/'))return res.writeHead(403).end();
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
 const stream=fs.createReadStream(file);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
});
const sessions=`export class BuildSession {
 constructor(url,{workers}){this.count=workers;this.coordinator={postMessage(){}};}
 postMessage(args){this.id=args.compiler==='clang'?'game-clang':'game';(window.testBuilds??={})[this.id]=this;this.onmessage({data:{kind:'ready',sources:['main.cpp'],workerCount:this.count}});}
 terminate(){this.closed=true;}
}`;
const player=`export class PlayerSession {
 async preload(){this.onpreload?.({kind:'preload-complete'});}
 async start(){if(Object.values(window.testBuilds).some(s=>!s.closed))throw Error('Compiler survived into playback');window.testStarts=(window.testStarts||0)+1;return {drawCalls:100};}
 close(){}
}`;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 for(const [name,engine]of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   for(const action of ['unanswered','wait','play','play-open','play-rerun','escape','cancel','failure','clang-first','desktop']){
    const desktop=action==='desktop',page=await browser.newPage({viewport:desktop?{width:1440,height:900}:{width:390,height:844},isMobile:!desktop,hasTouch:!desktop,reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    try{
     await page.route('**/build_session.mjs',route=>route.fulfill({contentType:'text/javascript',body:sessions}));
     await page.route('**/player_session.mjs',route=>route.fulfill({contentType:'text/javascript',body:player}));
     await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
     await page.waitForFunction(()=>!document.getElementById('run-workflow').disabled);
     assert.equal(await page.locator('#worker-choice').isVisible(),true);
     if(!desktop)assert.equal(await page.locator('#worker-choice option:checked').textContent(),'1 each');
     await page.locator('#worker-choice').selectOption('4');
     await page.locator('[data-phase=game]').click();
     await page.waitForFunction(()=>{
      const toolbar=document.querySelector('.workflow-toolbar').getBoundingClientRect(),heading=document.querySelector('.phase-heading').getBoundingClientRect();
      return toolbar.top>=-1&&heading.top>=toolbar.bottom&&heading.bottom<innerHeight;
     });
     if(desktop)await page.waitForFunction(()=>document.getElementById('build-grids').getBoundingClientRect().bottom<=innerHeight);
     const gap=await page.evaluate(()=>document.querySelector('#flow .flow-node').getBoundingClientRect().top-document.querySelector('#flow .setup-download').getBoundingClientRect().bottom);
     assert(gap<=40,'Seed has excess empty height');
     assert.equal(await page.evaluate(()=>window.testBuilds.game.count),2);
     assert.equal(await page.evaluate(()=>window.testBuilds['game-clang'].count),2);
     await page.evaluate(()=>window.staleClang=window.testBuilds['game-clang']);
     const emit=async(id,kind='complete')=>page.evaluate(({id,kind})=>window.testBuilds[id].onmessage({data:{kind,index:0,name:'main.cpp',compileSeconds:id==='game'?1:4,error:kind==='error'?'Clang test failure':undefined}}),{id,kind});
     if(action==='clang-first'){
      await emit('game-clang');assert.equal(await page.locator('#completion-modal').isVisible(),false);
      await emit('game');
     }else{
      await emit('game');
      assert.equal(await page.locator('#completion-title').textContent(),'Cppgm complete!');
      assert.equal(await page.locator('#completion-modal').isVisible(),true);
      assert.equal(await page.locator('#completion-modal').evaluate(e=>e.matches(':modal')),false,'Prompt hides or blocks the live build');
      assert.notEqual(await page.evaluate(()=>getComputedStyle(document.body).overflowY),'hidden');
      assert.equal(await page.evaluate(()=>!!window.testBuilds['game-clang'].closed),false,'Prompt terminated Clang');
      await page.locator('#units .unit').first().click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(action==='wait'){
       await page.locator('#completion-wait').click();
       assert.equal(await page.locator('#completion-wait').isDisabled(),true);
       await emit('game-clang','progress');
       assert.equal(await page.locator('#completion-modal').isVisible(),true,'Clang progress dismissed the prompt');
      }else if(action.startsWith('play')){
       await page.locator('#completion-play').click();
       await page.waitForFunction(()=>window.gamePlaying||window.gameError);
       assert.equal(await page.evaluate(()=>window.gameError),undefined);
       assert.equal(await page.locator('#completion-modal').isVisible(),false);
       assert.equal(await page.evaluate(()=>window.testBuilds['game-clang'].closed),true,'Play left Clang running');
       assert.equal(await page.evaluate(()=>window.lastClangGameBuild.reason),'play');
       assert.equal(await page.locator('#comparison-result').isVisible(),false,'Stopped compiler produced a misleading speedup');
       await emit('game-clang');await emit('game-clang','error');
       assert.equal(await page.evaluate(()=>window.gamePlaying),true,'Stopped coordinator interrupted playback');
       if(action!=='play-open')await page.locator('#game-close').click();
       if(action==='play-rerun'){
        await page.locator('#rerun-phase').click();
        const before=await page.evaluate(()=>window.lastClangGameBuild.kind);
        await page.evaluate(()=>{window.staleClang.onmessage({data:{kind:'complete',compileSeconds:99}});window.staleClang.onerror({message:'Old compiler error'});});
        assert.equal(await page.evaluate(()=>window.lastClangGameBuild.kind),before,'Old coordinator completed the new build');
        await emit('game');await emit('game-clang');await page.waitForFunction(()=>window.gamePlaying);
       }
       assert.equal(await page.evaluate(()=>window.testStarts),action==='play-rerun'?2:1);
       assert.equal(await page.locator('#game-modal').isVisible(),action!=='play');
       assert.deepEqual(errors,[]);console.log(`PASS: ${name} completion ${action}`);continue;
      }else if(action==='escape'||action==='cancel')await page.keyboard.press('Escape');
      if(action==='cancel'||action==='failure'){
       if(action==='cancel')await page.locator('#cancel').click();else await emit('game-clang','error');
       assert.equal(await page.locator('#completion-modal').isVisible(),false);
       assert.equal(await page.locator('#game-modal').isVisible(),false);
       assert.equal(await page.evaluate(()=>window.testStarts||0),0);
       await emit('game-clang');
       await page.locator('#rerun-phase').click();
       await emit('game');
       assert.equal(await page.locator('#completion-wait').isEnabled(),true,'Rerun retained waiting state');
       await emit('game-clang');
      }else await emit('game-clang');
     }
     assert.equal(await page.locator('#completion-modal').isVisible(),false);
     assert.equal(await page.evaluate(()=>window.testStarts),1,'Expected one launch per comparison');
     assert.equal(await page.locator('#game-modal').isVisible(),true);
     assert.equal(await page.locator('#comparison-result').isVisible(),true);
     assert.deepEqual(errors,[]);console.log(`PASS: ${name} completion ${action}`);
    }finally{await page.close();}
   }
  }finally{await browser.close();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
