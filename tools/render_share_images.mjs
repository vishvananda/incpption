#!/usr/bin/env node
// Reuse the site's logo markup and colors; no external fonts or image service.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=await readFile(path.join(root,'web/wasi_demo.html'),'utf8');
const css=await readFile(path.join(root,'web/wasi_demo.css'),'utf8');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({deviceScaleFactor:1});
 for(const [name,width,height,fontSize]of [['share-logo.png',1200,630,148],['site-icon.png',256,256,38]]){
  await page.setViewportSize({width,height});
  await page.setContent(`<style>${css}
   html,body{width:100%;height:100%;margin:0;padding:0}
   body{display:grid;place-items:center}
   .wordmark{font-size:${fontSize}px;color:var(--ink)}
  </style>`);
  await page.evaluate(source=>{
   const documentSource=new DOMParser().parseFromString(source,'text/html');
   document.body.append(documentSource.querySelector('.logo-title .wordmark').cloneNode(true));
  },html);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(root,'web',name)});
  console.log(`Rendered ${name}: ${width}×${height}`);
 }

 const wiwHTML=await readFile(path.join(root,'wiw/web/index.html'),'utf8');
 const wiwCSS=await readFile(path.join(root,'wiw/web/style.css'),'utf8');
 await page.setViewportSize({width:1200,height:630});
 await page.setContent(`<style>${css}\n${wiwCSS}
  body{display:grid;place-content:center;justify-items:center;gap:28px;min-height:100vh}
  .brand.wordmark{font-size:48px;color:var(--ink);text-decoration:none}
  h1{font-size:112px}
 </style>`);
 await page.evaluate(source=>{
  const documentSource=new DOMParser().parseFromString(source,'text/html');
  document.body.append(documentSource.querySelector('.mast .wordmark').cloneNode(true),
   documentSource.querySelector('h1').cloneNode(true));
 },wiwHTML);
 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:path.join(root,'wiw/web/share.png')});
 console.log('Rendered Will it Wasm? share.png: 1200×630');
}finally{await browser.close();}
