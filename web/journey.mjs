export function showJourney(name, {updateURL = true} = {}) {
  if (!['game', 'inception', 'roundtrip'].includes(name)) return;
  window.dispatchEvent(new CustomEvent('journey-changing', {detail: {name}}));
  window.activeJourney = name;
  for (const button of document.querySelectorAll('.journey-nav [data-journey]')) {
    button.setAttribute('aria-selected', String(button.dataset.journey === name));
    button.tabIndex = button.dataset.journey === name ? 0 : -1;
    if (button.dataset.journey === name) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  document.getElementById('workflow-panel')?.setAttribute('aria-labelledby', 'journey-'+name);
  if (updateURL) history.replaceState(null, '', '#' + name);
}
