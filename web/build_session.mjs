import {buildPolicy} from './build_policy.mjs';
// The page owns all workers, including replacements, so cancel stops work
// even while a compiler is inside a synchronous Wasm invocation.
export class BuildSession {
  constructor(url, {workers, maximum = 8, inputBroker, policy = buildPolicy()} = {}) {
    this.policy = policy; this.inputBroker = inputBroker;
    this.count = Math.max(1, Math.min(maximum, policy.maximum, Number(workers) || policy.defaultWorkers, crossOriginIsolated ? 8 : 1));
    this.children = []; this.ports = []; this.retiredWorkers = 0; this.closed = false;
    const channel = new MessageChannel(); this.control = channel.port1; this.controlPort = channel.port2;
    this.control.onmessage = ({data}) => {
      if (this.closed) return;
      let port;
      if (data.kind === 'retire') this.retire(data.index);
      else if (data.kind === 'replace') port = this.spawn(data.index);
      this.control.postMessage({request: data.request, port}, port ? [port] : []);
    };
    this.setCoordinator(url);
    for (let i = 0; i < this.count; i++) this.ports.push(this.spawn(i));
  }
  spawn(index) {
    const worker = new Worker('./compile_worker.mjs', {type: 'module'}), channel = new MessageChannel();
    worker.onerror = event => {if (!this.closed && this.children[index] === worker) this.onerror?.(event);};
    worker.postMessage({port: channel.port1}, [channel.port1]); this.children[index] = worker;
    return channel.port2;
  }
  retire(index) {if (this.children[index]) {this.children[index].terminate(); this.children[index] = null; this.retiredWorkers++;}}
  retireAll() {for (let i = 0; i < this.children.length; i++) this.retire(i);}
  inputConnection() {
    this.closeInputs?.();
    if (!this.inputBroker) return;
    const channel = new MessageChannel(); this.closeInputs = this.inputBroker.connect(channel.port1);
    return channel.port2;
  }
  setCoordinator(url) {
    const coordinator = new Worker(url, {type: 'module'}); this.coordinator = coordinator;
    coordinator.onmessage = event => {
      if (this.closed || this.coordinator !== coordinator) return;
      const data = event.data;
      if (data.kind === 'release-compilers') this.retireAll();
      if (data.kind === 'link-stage') {
        // A fresh realm releases Clang's compiled code and heaps before loading LLD.
        this.retireAll(); coordinator.terminate(); this.control.close();
        this.setCoordinator('./project_link_worker.mjs');
        this.onmessage?.({data: {kind: 'link-preparing'}});
        const inputPort = this.inputConnection();
        const buffers = [...data.files.map(file => file.bytes.buffer), ...(data.compilerBytes ? [data.compilerBytes.buffer] : [])];
        this.coordinator.postMessage({...data, inputPort}, [...new Set(buffers), ...(inputPort ? [inputPort] : [])]);
        return;
      }
      if (data.kind === 'complete') data.retiredWorkers = this.retiredWorkers;
      this.onmessage?.(event);
    };
    coordinator.onerror = event => {if (!this.closed && this.coordinator === coordinator) this.onerror?.(event);};
  }
  postMessage(data, transfers = []) {
    if (this.started) throw Error('Build session already started'); this.started = true;
    const inputPort = this.inputConnection();
    this.coordinator.postMessage({...data, workerCount: this.count, ports: this.ports, inputPort,
      controlPort: this.controlPort, recycleEvery: this.policy.recycleEvery, lowMemory: this.policy.lowMemory},
      [...transfers, ...this.ports, this.controlPort, ...(inputPort ? [inputPort] : [])]);
  }
  terminate() {
    if (this.closed) return; this.closed = true;
    this.coordinator.terminate(); this.closeInputs?.(); this.control.close(); this.retireAll();
  }
}
