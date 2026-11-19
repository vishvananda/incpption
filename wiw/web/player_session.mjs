// The packaged player renders inside an iframe. Parent controls never call
// into a busy game frame; all communication stays within this browser.
export class PlayerSession {
  constructor(surface, {url, log = () => {}}) {
    this.origin = new URL(url, location.href).origin;
    this.token = crypto.randomUUID(); this.log = log; this.draws = 0;
    this.requests = new Map(); this.sequence = 0; this.closed = false;
    this.frame = document.createElement('iframe');
    Object.assign(this.frame, {id:'game-frame', src:url, title:'Project built in this browser', allow:'autoplay; fullscreen'});
    this.receive = ({source, origin, data}) => {
      if (this.closed || source !== this.frame.contentWindow || origin !== this.origin || data?.channel !== 'cpp-inception-game') return;
      if (data.kind === 'ready') {this.readyResolve?.(); return;}
      if (data.token !== this.token) return;
      if (data.kind === 'log') this.log(data.message);
      if(data.kind==='progress')this.onprogress?.(data);
      if(data.kind?.startsWith('preload-'))this.onpreload?.(data);
      if (data.kind === 'draws') this.draws = data.count;
      if (data.kind === 'size' && this.project !== 'godot') this.frame.style.height = Math.max(240, Math.min(1200, data.height)) + 'px';
      if (data.kind === 'playing') {this.draws = data.count; this.frame.focus({preventScroll:true}); this.startResolve?.(this);}
      if (data.kind === 'error') this.startReject?.(Error(data.error));
      if (data.kind === 'ack') {this.requests.get(data.request)?.(); this.requests.delete(data.request);}
    };
    window.addEventListener('message', this.receive);
    this.ready = new Promise((resolve,reject) => {this.readyResolve = resolve; this.readyReject = reject;});
    surface.append(this.frame);
  }
  async start(build) {
    this.project=build.project;
    this.frame.dataset.project=build.project||'lara';
    if(build.project==='godot')Object.assign(this.frame.style,{height:'auto',minHeight:'0',aspectRatio:'1280 / 800'});
    const result = new Promise((resolve,reject) => {this.startResolve = resolve; this.startReject = reject;});
    // Register the rejection handler before a user can close during loading.
    result.catch(() => {});
    this.timeout = setTimeout(() => {this.readyReject?.(Error('Player did not load')); this.startReject?.(Error('Player did not start'));}, 300000);
    await this.ready;
    if (this.closed) throw Error('Player closed');
    this.post({kind:'start', build:{game:build.game, player:build.player, project:build.project}});
    try {return await result;} finally {clearTimeout(this.timeout);}
  }
  async preload(player) {
    await this.ready;
    this.post({kind:'preload',player});
  }
  post(data) {if (!this.closed) this.frame.contentWindow.postMessage({channel:'cpp-inception-game',token:this.token,...data}, this.origin);}
  command(kind) {
    if (this.closed) return Promise.resolve();
    const request = ++this.sequence;
    return new Promise(resolve => {this.requests.set(request,resolve); this.post({kind,request});});
  }
  pause() {return this.command('pause');}
  resume() {return this.command('resume');}
  get drawCalls() {return this.draws;}
  close() {
    if (this.closed) return;
    this.post({kind:'stop'}); this.closed = true; clearTimeout(this.timeout);
    this.readyReject?.(Error('Player closed')); this.startReject?.(Error('Player closed'));
    window.removeEventListener('message',this.receive);
    for (const resolve of this.requests.values()) resolve(); this.requests.clear();
    this.frame.remove();
  }
}
