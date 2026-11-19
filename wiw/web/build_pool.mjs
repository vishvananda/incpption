import {CompilePool} from './compile_pool.mjs';

export async function runCompilers(tasks, module, layers, count, completed) {
  if (!tasks.length) return;
  const ports = [], workers = [];
  try {
    for (let i = 0; i < Math.min(count, tasks.length); i++) {
      const worker = new Worker(new URL('./compile_worker.mjs', import.meta.url), {type: 'module'});
      const {port1, port2} = new MessageChannel();
      worker.postMessage({port: port2}, [port2]);
      ports.push(port1);
      workers.push(worker);
    }
    const pool = new CompilePool(ports);
    try {
      const failed = new Promise((_, reject) => {
        for (const worker of workers) worker.onerror = event => reject(Error(event.message));
      });
      await Promise.race([failed, pool.initialize(module, layers)]);
      await Promise.race([failed, pool.run(tasks, completed)]);
    } finally {
      pool.close();
    }
  } finally {
    for (const worker of workers) worker.terminate();
  }
}
