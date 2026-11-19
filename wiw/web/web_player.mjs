const policy = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; " +
  "connect-src blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; " +
  "media-src blob:; font-src data: blob:; base-uri https://package.invalid; form-action 'none'";

const types = {
  html:'text/html', js:'text/javascript', mjs:'text/javascript', wasm:'application/wasm',
  css:'text/css', json:'application/json', png:'image/png', svg:'image/svg+xml',
  jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', ico:'image/x-icon',
  woff:'font/woff', woff2:'font/woff2', ogg:'audio/ogg', mp3:'audio/mpeg', wav:'audio/wav',
};

// This function runs inside a sandboxed frame with an opaque origin.
function bootWebPlayer(csp) {
  async function load(event) {
    if (event.source !== parent || event.data?.type !== 'wiw-web-package') return;
    removeEventListener('message', load);
    const {entry, files} = event.data;
    const urls = new Map(files.map(({path, blob}) => [path, URL.createObjectURL(blob)]));
    const root = new URL(entry, 'https://package.invalid/');
    function resolve(value) {
      try {
        const url = new URL(value, root);
        if (url.origin === root.origin) return urls.get(decodeURIComponent(url.pathname.slice(1)));
      } catch {} // Leave malformed URLs to the browser's normal error handling.
    }
    const request = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = resolve(input instanceof Request ? input.url : input);
      return request(url && input instanceof Request ? new Request(url, input) : url ?? input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      return open.call(this, method, resolve(url) ?? url, ...args);
    };

    const source = await files.find(file => file.path === entry).blob.text();
    const page = new DOMParser().parseFromString(source, 'text/html');
    const meta = page.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = csp;
    const base = page.createElement('base');
    base.href = root.href;
    const fit = page.createElement('style');
    fit.textContent = 'canvas{max-width:100%;max-height:calc(100vh - 5rem)}';
    page.head.prepend(meta, base, fit);
    for (const element of page.querySelectorAll('[src], link[href], video[poster]')) {
      for (const name of ['src', 'href', 'poster']) {
        const value = element.getAttribute(name);
        if (value) element.setAttribute(name, resolve(value) ?? value);
      }
    }
    document.open();
    document.write('<!doctype html>' + page.documentElement.outerHTML);
    document.close();
  }
  addEventListener('message', load);
}

export function playWebPackage(surface, entry, files) {
  const frame = document.createElement('iframe');
  frame.title = 'Project built in this browser';
  frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  frame.allow = 'autoplay *; fullscreen *';
  frame.referrerPolicy = 'no-referrer';
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${policy}">
    <script>(${bootWebPlayer})(${JSON.stringify(policy)})</script>`;
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({type:'wiw-web-package', entry, files:files.map(({path, bytes}) =>
      ({path, blob:new Blob([bytes], {type:types[path.split('.').at(-1).toLowerCase()]})}))}, '*');
    frame.focus({preventScroll:true});
  }, {once:true});
  surface.append(frame);
  return {close:() => frame.remove()};
}
