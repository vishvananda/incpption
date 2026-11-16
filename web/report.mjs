document.querySelector('.metric').disabled = false;
const chart = document.querySelector('#phase-chart');
const phases = [...chart.querySelectorAll('.phase')];
for (const input of document.querySelectorAll('input[name="metric"]')) {
  input.addEventListener('change', () => {
    const metric = input.value;
    const key = metric === 'instructions' ? 'Instructions' : 'Cycles';
    const costs = phases.map(phase => ({
      clang: Number(phase.dataset[`clang${key}`]),
      cppgm: Number(phase.dataset[`cppgm${key}`]),
    }));
    const max = Math.max(...costs.map(cost => cost.clang));
    const gap = costs.reduce((sum, cost) => sum + cost.clang - cost.cppgm, 0);
    document.querySelector('#metric-name').textContent = metric;
    phases.forEach((phase, index) => {
      const cost = costs[index];
      for (const compiler of ['clang', 'cppgm']) {
        const bar = phase.querySelector(`.${compiler}`);
        bar.style.setProperty('--width', `${cost[compiler] / max * 100}%`);
        const value = cost[compiler].toFixed(1);
        bar.querySelector('span').textContent = value;
        bar.setAttribute('aria-label', `${compiler === 'clang' ? 'Clang' : 'cppgm'}: ${value} billion ${metric}`);
      }
      phase.querySelector('.share').textContent = `${Math.round((cost.clang - cost.cppgm) / gap * 100)}% of attributed gap`;
    });
  });
}
