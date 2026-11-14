export function showJourney(name, {updateURL = true} = {}) {
  if (!['game', 'inception', 'roundtrip'].includes(name)) return;
  window.dispatchEvent(new CustomEvent('journey-changing', {detail: {name}}));
  window.activeJourney = name;
  for (const button of document.querySelectorAll('.journey-nav [data-journey]')) {
    if (button.dataset.journey === name) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  if (updateURL) history.replaceState(null, '', '#' + name);
}
