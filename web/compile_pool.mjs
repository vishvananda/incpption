export class CompilePool {
  constructor(ports) {
    if (!ports?.length) throw Error('No compile workers were supplied');
    this.slots = ports.map(port => {
      const slot = {port};
      port.onmessage = ({data}) => {
        const pending = slot.pending;
        if (!pending) return;
        slot.pending = null;
        if (data.kind === 'error') pending.reject(Error(data.error));
        else pending.resolve(data);
      };
      port.onmessageerror = () => slot.pending?.reject(Error('Compile worker message could not be decoded'));
      return slot;
    });
  }
  send(slot, data) {
    if (slot.pending) throw Error('Compile worker already busy');
    return new Promise((resolve, reject) => {
      slot.pending = {resolve, reject};
      slot.port.postMessage(data);
    });
  }
  async initialize(module, layers, host = null) {
    await Promise.all(this.slots.map(slot => this.send(slot, {kind: 'init', module, layers, host})));
  }
  async run(tasks, completed) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(this.slots.map(async slot => {
      while (next < tasks.length) {
        const index = next++, task = tasks[index];
        postMessage({kind: 'progress', ...task.progress});
        const result = await this.send(slot, {kind: 'compile', index, args: task.args, output: task.output, language:task.language, sourceDateEpoch:task.sourceDateEpoch});
        results[index] = await completed(result, task, index);
      }
    }));
    return results;
  }
  close() {for (const slot of this.slots) slot.port.close();}
}
