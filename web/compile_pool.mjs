import {supportsProcessReuse} from './wasi_process.mjs';
import {supportsEmscriptenProcessReuse} from './emscripten_process.mjs';

export class CompilePool {
  constructor(ports, {controlPort, recycleEvery = 0} = {}) {
    if (!ports?.length) throw Error('No compile workers were supplied');
    this.control = controlPort; this.recycleEvery = recycleEvery;
    this.defaultRecycleEvery = recycleEvery;
    this.requests = new Map(); this.nextRequest = 0;
    if (controlPort) controlPort.onmessage = ({data}) => {
      const resolve = this.requests.get(data.request);
      this.requests.delete(data.request); resolve?.(data.port);
    };
    this.slots = ports.map((port, index) => {
      const slot = {index, uses: 0}; this.attach(slot, port); return slot;
    });
  }
  attach(slot, port) {
    slot.port = port;
    port.onmessage = ({data}) => {
      const pending = slot.pending;
      if (!pending) return;
      slot.pending = null;
      if (data.kind === 'error') pending.reject(Error(data.error));
      else pending.resolve(data);
    };
    port.onmessageerror = () => slot.pending?.reject(Error('Compile worker message could not be decoded'));
  }
  request(kind, index) {
    return new Promise(resolve => {
      const request = ++this.nextRequest; this.requests.set(request, resolve);
      this.control.postMessage({kind, index, request});
    });
  }
  send(slot, data) {
    if (slot.pending) throw Error('Compile worker already busy');
    return new Promise((resolve, reject) => {slot.pending = {resolve, reject}; slot.port.postMessage(data);});
  }
  async initialize(module, layers, host = null, count = this.slots.length) {
    if (!Number.isInteger(count) || count < 1 || count > this.slots.length) throw Error('Invalid active worker count');
    this.activeSlots = this.slots.slice(0, count);
    this.reuseProcess = module ? (host ? supportsEmscriptenProcessReuse(module, host.program) : supportsProcessReuse(module)) : false;
    this.recycleEvery = this.reuseProcess ? 0 : this.defaultRecycleEvery;
    this.init = {kind: 'init', module, layers, host};
    const ready = await Promise.all(this.activeSlots.map(async slot => {
      if (!slot.port) this.attach(slot, await this.request('replace', slot.index));
      slot.uses = 0;
      return await this.send(slot, this.init);
    }));
    this.reuseProcess = ready.every(row=>row.reuseProcess??this.reuseProcess);
    this.recycleEvery = this.reuseProcess ? 0 : this.defaultRecycleEvery;
  }
  async retire(slot) {
    if (!slot.port || !this.control) return;
    slot.port.close(); slot.port = null; slot.uses = 0;
    await this.request('retire', slot.index);
  }
  async retireAll() {await Promise.all(this.slots.map(slot => this.retire(slot)));}
  async execute(slot, task, index = 0) {
    if (!slot.port) {
      this.attach(slot, await this.request('replace', slot.index));
      await this.send(slot, this.init);
    }
    const result = await this.send(slot, {kind: 'compile', index, args: task.args, output: task.output,
      source: task.source, language: task.language, sourceDateEpoch: task.sourceDateEpoch,
      files: task.files, allowFailure: task.allowFailure});
    if (this.recycleEvery && ++slot.uses >= this.recycleEvery) await this.retire(slot);
    return result;
  }
  invoke(task) {return this.execute(this.slots[0], task);}
  async run(tasks, completed) {
    const results = new Array(tasks.length); let next = 0;
    await Promise.all(this.activeSlots.map(async slot => {
      while (next < tasks.length) {
        const index = next++, task = tasks[index];
        postMessage({kind: 'progress', ...task.progress});
        results[index] = await completed(await this.execute(slot, task, index), task, index);
      }
      await this.retire(slot);
    }));
    return results;
  }
  close() {for (const slot of this.slots) slot.port?.close(); this.control?.close(); this.init = null;}
}
