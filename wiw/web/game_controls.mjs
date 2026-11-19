// Touch buttons use the same keyboard callback as a physical keyboard. Keep
// each pointer independent so movement and an action can be held together.
export function attachGameControls(canvas,{profile='lara'}={}) {
  const controls = document.createElement('div');
  controls.className = 'game-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Touch game controls');
  const directions = document.createElement('div'), actions = document.createElement('div');
  directions.className = 'game-directions'; actions.className = 'game-actions';
  controls.append(directions, actions);
  const pointers = new Map(), held = new Map();
  const definitions = [
    ['up', '↑', 'Move forward', 'ArrowUp', 'ArrowUp', 38],
    ['left', '←', 'Turn left', 'ArrowLeft', 'ArrowLeft', 37],
    ['right', '→', 'Turn right', 'ArrowRight', 'ArrowRight', 39],
    ['down', '↓', 'Move backward', 'ArrowDown', 'ArrowDown', 40],
    ['action', 'Action', 'Action', 'Control', 'ControlLeft', 17],
    ['jump', 'Jump', 'Jump', 'Alt', 'AltLeft', 18],
    ['walk', 'Walk', 'Walk', 'Shift', 'ShiftLeft', 16],
    ['weapon', 'Weapons', 'Draw or holster weapons', ' ', 'Space', 32],
    ['menu', 'Menu', 'Open inventory or menu', 'Escape', 'Escape', 27],
    ['enter', 'Select', 'Select menu item', 'Enter', 'Enter', 13],
  ];
  if(profile==='doom'){definitions[4]=['action','Fire','Fire','MouseLeft','MouseLeft',0];definitions[5]=['jump','Jump','Jump',' ','Space',32];definitions[6]=['walk','Crouch','Crouch','c','KeyC',67];definitions[7]=['weapon','Reload','Reload','r','KeyR',82];}
  function key(type, definition) {
    const [, , , value, code, keyCode] = definition;
    if(code==='MouseLeft'){canvas.dispatchEvent(new MouseEvent(type==='keydown'?'mousedown':'mouseup',{button:0,bubbles:true,cancelable:true}));return;}
    canvas.dispatchEvent(new KeyboardEvent(type, {key: value, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true}));
  }
  function release(pointer) {
    const item = pointers.get(pointer);
    if (!item) return;
    pointers.delete(pointer);
    const remaining = held.get(item.definition[0]) - 1;
    held.set(item.definition[0], remaining);
    if (!remaining) {key('keyup', item.definition); item.button.setAttribute('aria-pressed', 'false');}
  }
  function releaseAll() {for (const pointer of [...pointers.keys()]) release(pointer);}
  for (const [index, definition] of definitions.entries()) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.control = definition[0];
    button.textContent = definition[1]; button.setAttribute('aria-label', definition[2]);
    button.setAttribute('aria-pressed', 'false');
    (index < 4 ? directions : actions).append(button);
    button.onpointerdown = event => {
      event.preventDefault();
      canvas.focus({preventScroll: true});
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, {button, definition});
      const count = held.get(definition[0]) || 0;
      held.set(definition[0], count + 1);
      if (!count) key('keydown', definition);
      button.setAttribute('aria-pressed', 'true');
    };
    button.onpointerup = button.onpointercancel = button.onlostpointercapture = event => release(event.pointerId);
    button.oncontextmenu = event => event.preventDefault();
  }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {if (document.hidden) releaseAll();});
  canvas.after(controls);
  return {element: controls, releaseAll};
}
