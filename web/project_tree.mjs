// A project view follows actual translation-unit results. Directory bars count
// completed files; a running file has no invented percentage.
export class ProjectTree {
  constructor(container, {onSelect, onSummary = () => {}}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onSummary = onSummary;
    this.status = new Map();
    this.expanded = new Set(['src']);
    this.filter = '';
    container.setAttribute('role', 'tree');
  }
  setProject(project, selected) {
    this.project = project;
    this.selected = selected;
    this.focused = selected;
    this.buildSources = new Set(project.buildSources);
    this.root = {name: project.name, path: '', children: new Map(), files: []};
    for (const file of project.files) {
      let node = this.root;
      const relative = file.path.startsWith(project.root + '/') ? file.path.slice(project.root.length + 1) : file.path;
      const parts = project.flat ? [relative.split('/').at(-1)] : relative.split('/');
      parts.forEach((name, index) => {
        const path = parts.slice(0, index + 1).join('/');
        if (!node.children.has(name)) node.children.set(name, {name, path, children: new Map(), files: []});
        node = node.children.get(name);
        node.files.push(file.path);
        if (index === parts.length - 1) node.file = file;
      });
    }
    this.container.setAttribute('aria-label', project.name + ' source files');
    this.render();
  }
  setStatus(status) {this.status = status; this.render();}
  setFilter(value) {this.filter = value.toLowerCase(); this.render();}
  select(path) {
    this.selected = path;
    const relative = path.startsWith(this.project.root + '/') ? path.slice(this.project.root.length + 1) : path;
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
    this.render();
  }
  summary(paths) {
    const sources = paths.filter(path => this.buildSources.has(path));
    const states = sources.map(path => this.status.get(path)?.state);
    return {total: sources.length, done: states.filter(s => s === 'matched' || s === 'built').length,
      matched: states.filter(s => s === 'matched').length, running: states.includes('running'), failed: states.includes('failed')};
  }
  render() {
    if (!this.project) return;
    const restoreFocus = this.container.contains(document.activeElement);
    const fragment = document.createDocumentFragment(), buttons = [];
    const add = (node, depth, parent) => {
      if (this.filter && !node.files.some(path => path.toLowerCase().includes(this.filter))) return;
      const folder = !node.file, stats = this.summary(node.files);
      const selected = node.file?.path === this.selected;
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'project-row'; row.dataset.path = node.path;
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
      row.style.setProperty('--depth', depth);
      const expanded = folder && (this.filter || this.expanded.has(node.path));
      if (folder) row.setAttribute('aria-expanded', String(Boolean(expanded)));
      else row.setAttribute('aria-selected', String(selected));
      const status = node.file ? this.status.get(node.file.path)?.state : '';
      row.classList.toggle('selected', selected);
      row.classList.toggle('running', stats.running);
      row.classList.toggle('failed', stats.failed);
      row.classList.toggle('matched', stats.total > 0 && stats.matched === stats.total);
      row.classList.toggle('built', stats.total > 0 && stats.done === stats.total);
      if (stats.running) row.setAttribute('aria-busy', 'true');
      row.tabIndex = node.path === this.focused ? 0 : -1;
      const arrow = document.createElement('span'); arrow.className = 'tree-arrow';
      arrow.textContent = folder ? (expanded ? '▾' : '▸') : '·'; arrow.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'tree-label';
      const bar = document.createElement('span'); bar.className = 'tree-bar'; bar.setAttribute('aria-hidden', 'true');
      bar.style.width = stats.total ? `${100 * stats.done / stats.total}%` : '0';
      const name = document.createElement('span'); name.textContent = node.name + (folder ? '/' : '');
      label.append(bar, name);
      const result = document.createElement('span'); result.className = 'tree-state';
      result.textContent = stats.failed ? '×' : stats.total && stats.matched === stats.total ? '✓' : folder && stats.total ? `${stats.done}/${stats.total}` : status === 'built' ? 'Built' : '';
      row.title = (node.file?.path || this.project.root + '/' + node.path) + (stats.total ? ` · ${stats.done}/${stats.total} built, ${stats.matched} matched` : ' · source input');
      row.append(arrow, label, result);
      row.onclick = () => {
        this.focused = node.path;
        if (folder) {if (this.expanded.has(node.path)) this.expanded.delete(node.path); else this.expanded.add(node.path); this.render();}
        else {this.selected = node.file.path; this.render(); this.onSelect(node.file);}
      };
      row.onkeydown = event => {
        const index = buttons.indexOf(row);
        let target;
        if (event.key === 'ArrowDown') target = buttons[index + 1];
        if (event.key === 'ArrowUp') target = buttons[index - 1];
        if (event.key === 'Home') target = buttons[0];
        if (event.key === 'End') target = buttons.at(-1);
        if (event.key === 'ArrowRight' && folder && !expanded) {this.expanded.add(node.path); this.render();}
        else if (event.key === 'ArrowLeft' && folder && expanded) {this.expanded.delete(node.path); this.render();}
        else if (event.key === 'ArrowLeft') target = buttons.find(button => button.dataset.path === parent);
        else if (!target) return;
        event.preventDefault();
        if (target) {this.focused = target.dataset.path; for (const button of buttons) button.tabIndex = button === target ? 0 : -1; target.focus();}
      };
      buttons.push(row); fragment.append(row);
      if (expanded) for (const child of [...node.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name))) add(child, depth + 1, node.path);
    };
    for (const node of [...this.root.children.values()].sort((a, b) => a.name.localeCompare(b.name))) add(node, 0, '');
    this.container.replaceChildren(fragment);
    if (!buttons.some(button => button.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
    if (restoreFocus) (buttons.find(button => button.dataset.path === this.focused) || buttons[0])?.focus();
    const paths = this.project.files.map(file => file.path);
    this.onSummary(this.summary(paths));
  }
}
