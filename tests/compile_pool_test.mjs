import assert from 'node:assert/strict';
import {CompilePool} from '../web/compile_pool.mjs';

const messages = [];
globalThis.postMessage = value => messages.push(value);

class Port {
  constructor(dispatches) {this.dispatches = dispatches; this.busy = false;}
  postMessage(data) {
    assert.equal(this.busy, false, 'a worker received overlapping invocations');
    this.busy = true;
    if (data.kind === 'compile') this.dispatches.push(data.index);
    queueMicrotask(() => {
      this.busy = false;
      this.onmessage({data: data.kind === 'init' ? {kind: 'ready'} : {kind: 'result', index: data.index}});
    });
  }
  close() {}
}

async function run(costs, expected) {
  const dispatches = [], pool = new CompilePool([new Port(dispatches), new Port(dispatches)]);
  await pool.initialize({}, []);
  const tasks = Object.freeze(costs.map((estimatedSeconds, index) => Object.freeze({
    estimatedSeconds, args: [], output: `${index}.o`, progress: {index, name: `file-${index}`},
  })));
  const before = messages.length, completed = [];
  const results = await pool.run(tasks, (result, task, index) => {
    assert.equal(result.index, index);
    assert.equal(task.output, `${index}.o`);
    completed.push(index);
    return task.output;
  });
  assert.deepEqual(dispatches, expected);
  assert.deepEqual(messages.slice(before).map(row => row.index), expected);
  assert.deepEqual(completed.toSorted((a,b) => a-b), tasks.map((_,index) => index));
  assert.deepEqual(results, tasks.map(task => task.output), 'results changed source order');
  pool.close();
}

await run([1, 9, 2, 9, undefined, NaN, -3, Infinity], [1, 3, 2, 0, 4, 5, 6, 7]);
await run([undefined, 0, NaN], [0, 1, 2]);
await run([], []);
console.log('PASS: expensive tasks start first; worker exclusivity, source indices and result order are preserved');
