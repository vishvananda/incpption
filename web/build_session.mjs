// The page owns every worker so cancel/restart can terminate the entire build,
// including compilers that are busy inside a synchronous WASI invocation.
export class BuildSession {
  constructor(url, {workers, maximum = 8, inputBroker} = {}) {
    const cores = navigator.hardwareConcurrency || 1;
    const requested = Number(workers) || Math.min(8, cores);
    this.count = Math.max(1, Math.min(maximum, requested, crossOriginIsolated ? 8 : 1));
    if(inputBroker){const channel=new MessageChannel();this.inputPort=channel.port2;this.closeInputs=inputBroker.connect(channel.port1);}
    this.coordinator = new Worker(url, {type: 'module'});
    this.children = [];
    this.ports = [];
    this.closed = false;
    this.coordinator.onmessage = event => {
      if (event.data.kind === 'release-compilers') {for (const child of this.children) child.terminate(); this.children.length = 0;}
      if (!this.closed) this.onmessage?.(event);
    };
    this.coordinator.onerror = event => {if (!this.closed) this.onerror?.(event);};
    for (let i = 0; i < this.count; i++) {
      const worker = new Worker('./compile_worker.mjs', {type: 'module'});
      const channel = new MessageChannel();
      worker.onerror = event => {if (!this.closed) this.onerror?.(event);};
      worker.postMessage({port: channel.port1}, [channel.port1]);
      this.children.push(worker);
      this.ports.push(channel.port2);
    }
  }
  postMessage(data, transfers = []) {
    if (this.started) throw Error('Build session already started');
    this.started = true;
    this.coordinator.postMessage({...data, workerCount: this.count, ports: this.ports, inputPort:this.inputPort}, [...transfers, ...this.ports, ...(this.inputPort?[this.inputPort]:[])]);
  }
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.coordinator.terminate(); this.closeInputs?.();
    for (const worker of this.children) worker.terminate();
    this.children.length = 0;
  }
}
