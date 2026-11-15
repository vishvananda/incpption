const share = document.getElementById('share');
const feedback = document.getElementById('share-feedback');
const status = document.getElementById('share-status');
const url = document.querySelector('link[rel="canonical"]').href;
share.onclick = async () => {
  status.textContent = ''; feedback.hidden = true;
  document.getElementById('share-link').hidden = true;
  if (navigator.share) {
    try {
      await navigator.share({title: document.title, text: document.querySelector('meta[name="description"]').content, url});
      return;
    } catch (error) {if (error.name === 'AbortError') return;}
  }
  try {await navigator.clipboard.writeText(url); status.textContent = 'Link copied'; feedback.hidden = false;}
  catch {
    const field = document.getElementById('share-link');
    field.hidden = false; field.value = url; field.focus(); field.select();
    status.textContent = 'Copy this link'; feedback.hidden = false;
  }
};

const logos = [...document.querySelectorAll('.wordmark')];
function animateLogo(logo) {
  for (const animation of logo.getAnimations({subtree:true})) animation.cancel();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const options = {duration:1900,fill:'none',easing:'ease-in-out'};
  logo.querySelector('.wordmark-cpp').animate([
    {transform:'translateY(1.12em)',offset:0}, {transform:'translateY(1.12em)',offset:.2},
    {transform:'translateY(0)',offset:.65}, {transform:'translateY(0)',offset:1}], options);
  logo.querySelector('.wordmark-cep').animate([
    {opacity:0,offset:0},{opacity:0,offset:.55},{opacity:1,offset:.9},{opacity:1,offset:1}], options);
  logo.querySelector('.wordmark-gm').animate([
    {opacity:0,transform:'translateX(-2ch)',offset:0}, {opacity:0,transform:'translateX(-2ch)',offset:.6},
    {opacity:1,transform:'translateX(0)',offset:1}], options);
}
for (const logo of logos) logo.addEventListener('click', () => animateLogo(logo));
if (document.readyState === 'complete') logos.forEach(animateLogo);
else window.addEventListener('load', () => logos.forEach(animateLogo), {once:true});
