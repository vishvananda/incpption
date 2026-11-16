const key = 'incpption-active-build-v1';
function tabStorage() {try {return globalThis.sessionStorage;} catch {return null;}}
// Save only small progress records, never compiler inputs or outputs. A killed
// web process cannot report an exception, but the next page can show its last step.
export class BuildJournal {
  constructor(storage = tabStorage(), now = Date.now) {
    this.storage = storage; this.now = now; this.active = new Map(); this.last = -Infinity;
    try {
      const raw = storage?.getItem(key);
      if (raw && raw.length < 16384) {
        const data = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.phases)) this.previous = data;
      }
      storage?.removeItem(key);
    } catch {}
  }
  update(id, value, force = false) {
    this.active.set(id, {...value, id});
    if (force || this.now() - this.last >= 1000) this.flush();
  }
  finish(id) {this.active.delete(id); this.flush();}
  flush() {
    const time = this.now(); this.last = time;
    try {
      if (this.active.size) this.storage?.setItem(key, JSON.stringify({version: 1, time, phases: [...this.active.values()]}));
      else this.storage?.removeItem(key);
    } catch {}
  }
}
