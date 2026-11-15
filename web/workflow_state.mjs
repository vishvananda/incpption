export const paths = {game: ['game', 'game-clang'], inception: ['match', 'game'], roundtrip: ['llvm', 'clang', 'match', 'game']};
export const isGame = id => id === 'game' || id === 'game-clang';
const empty = names => ({state: 'waiting', seconds: 0, names: [...names], rows: new Map(), running: new Set()});
// Compiler stages survive a target change. Game results belong to their target.
export class WorkflowState {
  constructor() {this.workflows = new Map();}
  key(id, target) {return isGame(id) ? `${id}:${target}` : id;}
  phase(scenario, target, id, names = []) {
    if (!this.workflows.has(scenario)) this.workflows.set(scenario, new Map());
    const phases = this.workflows.get(scenario), key = this.key(id, target);
    if (!phases.has(key)) phases.set(key, empty(names));
    return phases.get(key);
  }
  completed(scenario, target) {return paths[scenario].every(id => this.phase(scenario, target, id).state === 'done');}
  invalidate(scenario, target, id) {
    const phases = this.workflows.get(scenario);
    const later = scenario === 'game' ? paths.game : paths[scenario].slice(paths[scenario].indexOf(id));
    const removed = [];
    if (!phases) return removed;
    for (const [key, row] of phases) if (later.some(item => key === item || key.startsWith(item + ':'))) {
      // Rebuilding a compiler invalidates games for every target that used it.
      if (!isGame(id) || key.endsWith(':' + target)) {removed.push(row); phases.delete(key);}
    }
    return removed;
  }
  totalSeconds(scenario, target, elapsed) {
    const values = paths[scenario].map(id => elapsed(this.phase(scenario, target, id)));
    return scenario === 'game' ? Math.max(...values) : values.reduce((a,b) => a+b, 0);
  }
}
