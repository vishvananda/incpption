const assert=require('node:assert/strict'),path=require('node:path');
exports.openCreate=async page=>{
  const canvas=page.frameLocator('#game-frame').locator('#canvas'),box=await canvas.boundingBox();
  const before=await page.evaluate(()=>window.openLaraGame.drawCalls);
  await canvas.click({position:{x:box.width*35/1280,y:box.height*50/800}});
  await page.waitForFunction(previous=>window.openLaraGame.drawCalls>previous,before);
  return{canvas,box};
};
exports.createProject=async(page,compiler,out)=>{
  const {canvas,box}=await exports.openCreate(page),old=await canvas.elementHandle();
  await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type('Browser '+compiler);
  await canvas.click({position:{x:box.width*720/1280,y:box.height*588/800}});
  await old.waitForElementState('hidden');await old.dispose();
  const afterExit=await page.evaluate(()=>window.openLaraGame.drawCalls);
  await page.waitForFunction(previous=>window.openLaraGame.drawCalls>previous+3,afterExit);
  assert(!await page.locator('#log').textContent().then(text=>text.includes('Invalid project path')),'created project was lost during editor restart');
  await canvas.screenshot({path:path.join(out,'godot-'+compiler+'-editor.png')});
};
