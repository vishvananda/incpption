import assert from 'node:assert/strict';
import test from 'node:test';
import {tar} from '../web/tar.mjs';
import {workspaceCache} from '../web/wanix_workspace.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder();

test('Wanix workspace deltas reuse unchanged files and update links and deletions', () => {
  const cache = workspaceCache();
  const initialArchive = tar([
    ['include.h', new Uint8Array()],
    ['source.c', encoder.encode('int main(void) {}')],
    ['generated.h', encoder.encode('#define ANSWER 1')],
  ]);
  // Mark the first tar entry as a symlink to the generated header.
  const header = initialArchive.subarray(0, 512);
  header[156] = '2'.charCodeAt(0);
  header.set(encoder.encode('generated.h'), 157);
  const initial = cache(initialArchive, []);
  assert.equal(decoder.decode(initial.get('include.h')), '#define ANSWER 1');

  const updated = cache(tar([['generated.h', encoder.encode('#define ANSWER 2')]]), []);
  assert.equal(updated.get('source.c'), initial.get('source.c'));
  assert.equal(decoder.decode(updated.get('include.h')), '#define ANSWER 2');
  assert.equal(decoder.decode(initial.get('include.h')), '#define ANSWER 1');

  const removed = cache(tar([]), ['generated.h']);
  assert.deepEqual([...removed.keys()], ['source.c']);

  const replaced = cache(tar([['include.h', encoder.encode('#define ANSWER 3')]]), []);
  assert.equal(decoder.decode(replaced.get('include.h')), '#define ANSWER 3');
});
