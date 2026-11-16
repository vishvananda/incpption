#!/usr/bin/env node
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {renderReport} from './report_markdown.mjs';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web');

export function createReportPreview(webDir=web){
 return http.createServer(async(req,res)=>{
  try{
   const route=new URL(req.url,'http://localhost').pathname;
   res.setHeader('Cache-Control','no-store');
   if(route==='/'||route==='/report.html'){
    const [markdown,template]=await Promise.all(['report.md','report.template.html'].map(name=>readFile(path.join(webDir,name),'utf8')));
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(renderReport(markdown,template));
   }else if(route==='/report.css'||route==='/report.mjs'){
    res.setHeader('Content-Type',route.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(path.join(webDir,route.slice(1))));
   }else res.writeHead(404).end('Not found');
  }catch(error){res.writeHead(500,{'Content-Type':'text/plain'}).end(error.stack);}
 });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),port=args.length===2&&args[0]==='--port'?Number(args[1]):8000;
 if(args.length&&(args.length!==2||args[0]!=='--port')||!Number.isInteger(port)||port<0||port>65535)throw Error('Usage: npm run preview:report -- [--port 8000]');
 const server=createReportPreview();
 server.listen(port,'127.0.0.1',()=>console.log('Report preview: http://127.0.0.1:'+server.address().port+'/report.html (refresh after saving Markdown)'));
}
