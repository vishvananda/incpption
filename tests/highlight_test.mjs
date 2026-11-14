import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(resolve(tmpdir(), 'incpption-highlight-'));
try {
  mkdirSync(resolve(temporary, 'vendor'));
  execFileSync('python3', ['-c', `import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from inspector_vendor import prepare_vendor; prepare_vendor(Path(sys.argv[2]))`, resolve(root, 'tools'), resolve(temporary, 'built-vendor')]);
  writeFileSync(resolve(temporary, 'vendor/prism.mjs'), readFileSync(resolve(temporary, 'built-vendor/prism.mjs')));
  writeFileSync(resolve(temporary, 'highlight.mjs'), readFileSync(resolve(root, 'web/highlight.mjs')));
  const {highlight, highlightCode} = await import(pathToFileURL(resolve(temporary, 'highlight.mjs')));
  const samples = {
    cpp: 'extern "C" int answer(int n) { return n * 2; }',
    lowir: 'function @answer(%n : i32) -> i32 {\n block ^entry:\n %t1 = binary mul i32 %n, 2\n return i32 %t1\n}',
    wasm: '(module (func $answer (param i32) (result i32) local.get 0 i32.const 2 i32.mul))',
    x86: '; Real decoded instructions\nanswer:\n000000  mov eax,edi\n000002  imul eax,eax\n000005  ret',
  };
  for (const [language, sample] of Object.entries(samples)) {
    const html = highlight(sample, language);
    assert.match(html, /class="token [^"]*keyword/);
    assert.match(html, /class="token (?:number|variable|register)/);
  }
  assert.match(highlight('v128.load i32.atomic.rmw.add try_table throw_ref', 'wasm'), /token instruction keyword/);
  assert.match(highlight('ptr obj<8x4> @compiler %value $slot ^entry', 'lowir'), /token class-name/);
  for (const language of ['cpp', 'lowir', 'wasm', 'x86', 'unknown']) {
    const html = highlight('</code><img src=x onerror="alert(1)">&unsafe', language);
    assert(!html.includes('<img') && !html.includes('</code>'));
    assert(html.includes('&lt;') && html.includes('&amp;'));
  }
  const classes = new Set(['code-view', 'language-cpp']);
  const element = {classList: {add: value => classes.add(value), remove: value => classes.delete(value), [Symbol.iterator]: () => classes.values()}};
  highlightCode(element, samples.lowir, 'lowir');
  assert.deepEqual([...classes], ['code-view', 'language-lowir']);
  assert.match(element.innerHTML, /token keyword/);
  highlightCode(element, '<script>', 'unexpected" onclick="bad');
  assert(classes.has('language-text'));
  assert.equal(element.innerHTML, '&lt;script>');
  console.log('PASS: C++, LowIR, WAT and Intel assembly highlighting; unsafe text escaped');
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
