import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renderReport} from '../tools/report_markdown.mjs';
import {createReportPreview} from '../tools/preview_report.mjs';
const source=await readFile(new URL('../web/report.md',import.meta.url),'utf8');
const template=await readFile(new URL('../web/report.template.html',import.meta.url),'utf8');
const rendered=renderReport(source,template);
assert.equal(rendered,renderReport(source,template),'Rendering must be deterministic');
assert.match(rendered,/<section id="improvements"/);
assert.match(rendered,/<details id="lexing-evidence"/);
assert.match(rendered,/<caption>Billions/);
const edited=source.replace('title: "Compilation cost study · cppgm inception"','title: "Editor <draft> & review"')
 .replace('| Front end | 126.3 |','| Front end | 130.5 |')
 +'\n### Does an edited question appear?\n\nA **clear** answer with `code` and [a link](https://example.com/).\n';
const changed=renderReport(edited,template);
assert.match(changed,/<title>Editor &lt;draft&gt; &amp; review<\/title>/);
assert.match(changed,/data-clang-instructions="130.5"/);
assert.match(changed,/Clang: 130.5 billion instructions/);
assert.match(changed,/<summary>Does an edited question appear\?<\/summary><p>A <strong>clear<\/strong> answer with <code>code<\/code> and <a href="https:\/\/example.com\/">a link<\/a>/);
assert.throws(()=>renderReport(source.replace('| Front end | 126.3 |','| Front end | invalid |'),template),/Invalid phase cost/);
assert.throws(()=>renderReport(source.replace('<!-- phase-chart -->','<!-- phase-chart -->\n\nNot a table.'),template),/must be followed by a Markdown table/);
const dir=await mkdtemp(path.join(os.tmpdir(),'incpption-report-'));
const server=createReportPreview(dir);
try{
 for(const [name,bytes]of [['report.md',source],['report.template.html',template],['report.css','body{}'],['report.mjs','export {};']])await writeFile(path.join(dir,name),bytes);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 assert.equal(await(await fetch(base+'/report.html')).text(),rendered);
 await writeFile(path.join(dir,'report.md'),edited);
 const response=await fetch(base+'/report.html');
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(await response.text(),changed,'Refreshing the preview must render saved edits');
 assert.equal((await fetch(base+'/report.css')).status,200);
 assert.equal((await fetch(base+'/report.mjs')).status,200);
 assert.equal((await fetch(base+'/not-a-site-file')).status,404);
}finally{
 await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
}
console.log('PASS: editable Markdown, metadata, chart data, FAQ rendering, clear errors and fresh previews');
