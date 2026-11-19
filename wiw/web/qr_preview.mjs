export function qrPreview(dialog, bytes) {
  const form = dialog.querySelector('form');
  const text = form.querySelector('input'), image = dialog.querySelector('img');
  const status = dialog.querySelector('[role=status]'), button = form.querySelector('button');
  const module = WebAssembly.compile(bytes);
  let worker, timer, url;
  function stop() {
    worker?.terminate();
    worker = null;
    clearTimeout(timer);
  }
  async function render() {
    stop();
    const job = worker = new Worker(new URL('./qr_worker.mjs', import.meta.url), {type:'module'});
    button.disabled = true;
    status.textContent = 'Generating QR code…';
    function finish(error) {
      stop();
      button.disabled = false;
      status.textContent = error || '';
    }
    job.onerror = () => finish('The QR generator stopped.');
    job.onmessage = ({data}) => {
      if (data.error) return finish(data.error);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([data.output], {type:'image/svg+xml'}));
      image.src = url;
      image.hidden = false;
      finish();
    };
    timer = setTimeout(() => finish('The QR generator timed out.'), 10000);
    try {
      const compiled = await module;
      if (worker === job) job.postMessage({module:compiled, text:text.value});
    } catch (error) {if (worker === job) finish(error.message);}
  }
  form.onsubmit = event => {event.preventDefault();void render();};
  dialog.onclose = () => {
    stop();
    if (url) URL.revokeObjectURL(url);
    image.removeAttribute('src');
    image.hidden = true;
  };
  dialog.showModal();
  void render();
}
