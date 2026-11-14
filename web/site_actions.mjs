const share = document.getElementById('share');
const status = document.getElementById('share-status');
const url = document.querySelector('link[rel="canonical"]').href;
share.onclick = async () => {
  status.textContent = '';
  if (navigator.share) {
    try {
      await navigator.share({title: 'cpp inception', text: 'Watch a self-built C++ compiler rebuild itself in your browser, then build and play a game.', url});
      return;
    } catch (error) {if (error.name === 'AbortError') return;}
  }
  try {await navigator.clipboard.writeText(url); status.textContent = 'Link copied';}
  catch {
    const field = document.getElementById('share-link');
    field.hidden = false; field.value = url; field.focus(); field.select();
    status.textContent = 'Copy this link';
  }
};
