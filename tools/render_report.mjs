#!/usr/bin/env node
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderReport} from './report_markdown.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output')throw Error('Usage: node tools/render_report.mjs --output path/report.html');
const output=path.resolve(args[1]);
const [markdown,template]=await Promise.all(['report.md','report.template.html'].map(name=>readFile(path.join(root,'web',name),'utf8')));
const html=renderReport(markdown,template);
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,html);
for(const name of ['report.css','report.mjs'])await copyFile(path.join(root,'web',name),path.join(path.dirname(output),name));
console.log('Rendered report: '+output);
