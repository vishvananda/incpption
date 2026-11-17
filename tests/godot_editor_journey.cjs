const assert=require('node:assert/strict'),path=require('node:path');
exports.openImport=async(page,compiler,out)=>{
  const canvas=page.frameLocator('#game-frame').locator('#canvas'),box=await canvas.boundingBox();
  const region={x:box.x+box.width*.3,y:box.y+box.height*.2,width:box.width*.4,height:box.height*.4};
  const before=await page.screenshot({clip:region});
  await canvas.click({position:{x:box.width*640/1280,y:box.height*425/800}});
  await page.waitForTimeout(400);
  const opened=await page.screenshot({clip:region});
  assert(!before.equals(opened),'Import Existing Project did not open its dialog');
  await canvas.screenshot({path:path.join(out,'godot-'+compiler+'-import.png')});
  await canvas.click({position:{x:box.width*495/1280,y:box.height*644/800}});
  await page.waitForTimeout(200);
  assert(await page.locator('#game-modal').isVisible(),'Import dismissed the player modal');
};
exports.openCreate=async(page,{center=false}={})=>{
  const canvas=page.frameLocator('#game-frame').locator('#canvas'),box=await canvas.boundingBox();
  const before=await page.evaluate(()=>window.openLaraGame.drawCalls);
  await canvas.click({position:{x:box.width*(center?507:35)/1280,y:box.height*(center?425:50)/800}});
  await page.waitForFunction(previous=>window.openLaraGame.drawCalls>previous,before);
  return{canvas,box};
};
exports.createProject=async(page,compiler,out,options)=>{
  const {canvas,box}=await exports.openCreate(page,options),old=await canvas.elementHandle();
  await canvas.screenshot({path:path.join(out,'godot-'+compiler+'-create.png')});
  await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('Browser '+compiler);
  await canvas.click({position:{x:box.width*720/1280,y:box.height*588/800}});
  await old.waitForElementState('hidden');await old.dispose();
  const afterExit=await page.evaluate(()=>window.openLaraGame.drawCalls);
  await page.waitForFunction(previous=>window.openLaraGame.drawCalls>previous+3,afterExit);
  assert(!await page.locator('#log').textContent().then(text=>text.includes('Invalid project path')),'created project was lost during editor restart');
  await canvas.screenshot({path:path.join(out,'godot-'+compiler+'-editor.png')});
};
