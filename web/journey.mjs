export function showJourney(name, {updateURL = true} = {}) {
  if (!['game', 'inception', 'roundtrip'].includes(name)) return;
  window.dispatchEvent(new CustomEvent('journey-changing', {detail: {name}}));
  window.activeJourney = name;
  for (const id of ['game', 'inception', 'roundtrip']) document.getElementById(id).hidden = id !== name;
  for (const button of document.querySelectorAll('.journey-nav [data-journey]')) {
    if (button.dataset.journey === name) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  const explorer = document.getElementById('explorer');
  explorer.hidden = name === 'roundtrip';
  if (name !== 'roundtrip') document.getElementById(name + '-workspace-slot').append(explorer);
  window.dispatchEvent(new CustomEvent('project-select', {detail: {project: name === 'game' ? 'game' : 'cppgm'}}));
  if (updateURL) history.replaceState(null, '', '#' + name);
}
for (const button of document.querySelectorAll('[data-journey]')) button.addEventListener('click', event => {
  event.preventDefault(); showJourney(button.dataset.journey);
});
showJourney(['#inception', '#roundtrip'].includes(location.hash) ? location.hash.slice(1) : 'game', {updateURL: false});
