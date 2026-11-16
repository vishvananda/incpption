// Observe coordinator messages without copying compiler modules or object bytes.
(() => {
  const NativeWorker = window.Worker;
  let nextLane = 0;
  window.compileEvents = [];
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.observedURL = String(url);
      if (this.observedURL.includes('project_worker')) this.observedLane = nextLane++ % 2 ? 'clang' : 'cppgm';
      this.addEventListener('message', ({data}) => {
        if (!this.observedLane) return;
        const row = {lane: this.observedLane, at: performance.now()};
        for (const key of ['kind', 'index', 'name', 'source', 'seconds', 'compileSeconds', 'bytes', 'memoryBytes', 'workerCount', 'sha256', 'error'])
          if (data[key] !== undefined) row[key] = data[key];
        window.compileEvents.push(row);
      });
    }
    postMessage(data, ...rest) {
      if (this.observedURL.includes('project_link_worker')) this.observedLane = data.clang ? 'clang' : 'cppgm';
      if (data.kind === 'start' && this.observedLane)
        window.compileEvents.push({lane: this.observedLane, kind: 'start', at: performance.now()});
      return super.postMessage(data, ...rest);
    }
  };
})();
