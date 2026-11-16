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
 async start(){window.testStarts=(window.testStarts||0)+1;return {drawCalls:100};}
 close(){}
}`;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 for(const [name,engine]of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   for(const action of ['unanswered','wait','play','play-open','play-failure','escape','cancel','failure','clang-first']){
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    try{
     await page.route('**/build_session.mjs',route=>route.fulfill({contentType:'text/javascript',body:sessions}));
     await page.route('**/player_session.mjs',route=>route.fulfill({contentType:'text/javascript',body:player}));
     await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
     await page.waitForFunction(()=>!document.getElementById('run-workflow').disabled);
     await page.locator('[data-phase=game]').click();
     const emit=async(id,kind='complete')=>page.evaluate(({id,kind})=>window.testBuilds[id].onmessage({data:{kind,index:0,name:'main.cpp',compileSeconds:id==='game'?1:4,error:kind==='error'?'Clang test failure':undefined}}),{id,kind});
     if(action==='clang-first'){
      await emit('game-clang');assert.equal(await page.locator('#completion-modal').isVisible(),false);
      await emit('game');
     }else{
      await emit('game');
      assert.equal(await page.locator('#completion-title').textContent(),'Cppgm complete!');
      assert.equal(await page.locator('#completion-modal').isVisible(),true);
      assert.equal(await page.evaluate(()=>!!window.testBuilds['game-clang'].closed),false,'Clang was terminated');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(action==='wait'){
       await page.locator('#completion-wait').click();
       assert.equal(await page.locator('#completion-wait').isDisabled(),true);
       assert.equal(await page.locator('#completion-modal').isVisible(),true);
       await emit('game-clang','progress');
       assert.equal(await page.locator('#completion-modal').isVisible(),true,'Clang progress dismissed the prompt');
      }else if(action==='play'||action==='play-open'||action==='play-failure'){
       await page.locator('#completion-play').click();
       await page.waitForFunction(()=>window.gamePlaying);
       assert.equal(await page.locator('#completion-modal').isVisible(),false);
       assert.equal(await page.evaluate(()=>!!window.testBuilds['game-clang'].closed),false,'Play stopped Clang');
       if(action==='play-failure'){
        await emit('game-clang','error');
        assert.equal(await page.locator('#game-modal').isVisible(),false,'Compiler failure left an empty game modal');
        assert.equal(await page.evaluate(()=>window.gamePlaying),false);
        await emit('game-clang');
        assert.equal(await page.evaluate(()=>window.testStarts),1,'Failed coordinator relaunched the game');
        assert.deepEqual(errors,[]);
        console.log(`PASS: ${name} completion ${action}`);continue;
       }
       if(action==='play')await page.locator('#game-close').click();
      }else if(action==='escape'||action==='cancel')await page.keyboard.press('Escape');
      if(action==='cancel'||action==='failure'){
       if(action==='cancel')await page.locator('#cancel').click();else await emit('game-clang','error');
       assert.equal(await page.locator('#completion-modal').isVisible(),false);
       assert.equal(await page.locator('#game-modal').isVisible(),false);
       assert.equal(await page.evaluate(()=>window.testStarts||0),0);
       // A cancelled coordinator cannot launch a stale result; rerun is clean.
       await emit('game-clang');
       await page.locator('#rerun-phase').click();
       assert.equal(await page.locator('#completion-modal').isVisible(),false);
       await emit('game');
       assert.equal(await page.locator('#completion-wait').isEnabled(),true,'Rerun retained waiting state');
       await emit('game-clang');
      }else await emit('game-clang');
     }
     assert.equal(await page.locator('#completion-modal').isVisible(),false);
     assert.equal(await page.evaluate(()=>window.testStarts),1,'Expected one launch per comparison');
     assert.equal(await page.locator('#game-modal').isVisible(),action!=='play','Clang completion restarted a closed game');
     assert.equal(await page.locator('#comparison-result').isVisible(),true);
     assert.deepEqual(errors,[]);
     console.log(`PASS: ${name} completion ${action}`);
    }finally{await page.close();}
   }
  }finally{await browser.close();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
