// Control bindings and the DS screen layout: the stored settings, the
// lookup tables the emulation loop reads, and the panel that edits them.
//
// Bindings are stored by button name -- that is the order the settings
// screen lists them in, and it is the only spelling shared by all three
// consoles (renderer.js and preload.js both work in names, never ordinals).
// The reverse maps the hot path actually needs are derived from it.

// Every button any of the three consoles has, in the order a settings
// screen should show them. A console without a given button just ignores it
// (see preload.js, which owns the name -> ordinal translation).
const BUTTONS = [
  ['up', 'Arriba'],
  ['down', 'Abajo'],
  ['left', 'Izquierda'],
  ['right', 'Derecha'],
  ['a', 'A'],
  ['b', 'B'],
  ['x', 'X (DS y 3DS)'],
  ['y', 'Y (DS y 3DS)'],
  ['l', 'L'],
  ['r', 'R'],
  ['zl', 'ZL (solo 3DS)'],
  ['zr', 'ZR (solo 3DS)'],
  ['select', 'Select'],
  ['start', 'Start'],
];

// Gamepad indices follow the Gamepad API's "standard" mapping, so anything
// the browser recognises as standard works with no per-pad configuration.
// Face buttons follow the physical Nintendo layout rather than the labels:
// index 0 is the bottom button, which is where A sits on a DS or a GBA.
const DEFAULT_BINDINGS = {
  up: { key: 'arrowup', pad: 12 },
  down: { key: 'arrowdown', pad: 13 },
  left: { key: 'arrowleft', pad: 14 },
  right: { key: 'arrowright', pad: 15 },
  a: { key: 'x', pad: 0 },
  b: { key: 'z', pad: 1 },
  x: { key: 's', pad: 3 },
  y: { key: 'a', pad: 2 },
  l: { key: 'q', pad: 4 },
  r: { key: 'w', pad: 5 },
  // The triggers, next to the bumpers that are L and R.
  zl: { key: 'e', pad: 6 },
  zr: { key: 'r', pad: 7 },
  select: { key: 'shift', pad: 8 },
  start: { key: 'enter', pad: 9 },
};

const DEFAULT_DS_LAYOUT = 'vertical';

// Anything else in the file is ignored rather than trusted -- a speed of 0
// would stall the emulation loop outright.
const SPEEDS = [0.5, 1, 2, 4];

let stored = settings.read();
let bindings = { ...DEFAULT_BINDINGS, ...(stored.bindings || {}) };
let dsLayout = stored.dsLayout === 'horizontal' ? 'horizontal' : DEFAULT_DS_LAYOUT;
let speed = SPEEDS.includes(stored.speed) ? stored.speed : 1;
// filter.js owns the value and validates it.
setImageFilter(stored.imageFilter);

function setSpeed(value) {
  if (!SPEEDS.includes(value)) return;
  speed = value;
  persist();
}

// What the emulation loop reads sixty times a second, rebuilt whenever a
// binding changes rather than searched on every event.
let keyToButton = {};
let padToButton = {};

function rebuildLookups() {
  keyToButton = {};
  padToButton = {};
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.key) keyToButton[binding.key] = name;
    if (binding.pad !== null && binding.pad !== undefined) padToButton[binding.pad] = name;
  }
}

function persist() {
  // Spread what is already there: this file is not the only writer --
  // hub.js records a dismissed update in it too, and rewriting only these
  // three keys would silently drop that.
  settings.write({ ...settings.read(), bindings, dsLayout, speed, imageFilter });
}

rebuildLookups();

// ---- The settings panel -----------------------------------------------

const bindingList = document.getElementById('bindings');
const layoutSelect = document.getElementById('ds-layout');
const filterSelect = document.getElementById('image-filter');

// Set while waiting for the user to press something. The emulation loop
// checks this so a rebind doesn't also move the character.
let capturing = null;

function isCapturing() {
  return capturing !== null;
}

// e.key for a printable character is the character itself, which changes
// with Shift; lowercasing keeps 'x' and 'X' the same binding. Everything
// else ('ArrowUp', 'Shift') is already stable.
function keyName(event) {
  return event.key.toLowerCase();
}

function keyLabel(key) {
  if (!key) return '—';
  if (key.startsWith('arrow')) {
    return { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }[key];
  }
  return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

function renderBindings() {
  bindingList.replaceChildren(
    ...BUTTONS.map(([name, label]) => {
      const row = document.createElement('li');

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = label;

      const keyButton = document.createElement('button');
      keyButton.textContent =
        capturing?.name === name && capturing.kind === 'key'
          ? 'pulsa una tecla…'
          : keyLabel(bindings[name]?.key);
      keyButton.addEventListener('click', () => beginCapture(name, 'key'));

      const padButton = document.createElement('button');
      const pad = bindings[name]?.pad;
      padButton.textContent =
        capturing?.name === name && capturing.kind === 'pad'
          ? 'pulsa un botón…'
          : pad === null || pad === undefined
            ? '—'
            : `Botón ${pad}`;
      padButton.addEventListener('click', () => beginCapture(name, 'pad'));

      row.append(title, keyButton, padButton);
      return row;
    }),
  );
}

// Pads raise no events, so a capture polls for the first button that goes
// down. Its own timer, not the emulation loop's: the settings screen is
// usually open with nothing running, and even during a paused game that
// loop is stopped.
let capturePoll = null;

function beginCapture(name, kind) {
  capturing = { name, kind };
  clearInterval(capturePoll);
  if (kind === 'pad') capturePoll = setInterval(pollCapture, 50);
  renderBindings();
}

function endCapture() {
  capturing = null;
  clearInterval(capturePoll);
  capturePoll = null;
}

function assign(name, kind, value) {
  // A key or pad button can only drive one console button, so taking one
  // that is already in use frees it rather than leaving a silent duplicate
  // where only one of the two would ever fire.
  for (const [other, binding] of Object.entries(bindings)) {
    if (other !== name && binding[kind] === value) binding[kind] = null;
  }
  bindings[name] = { ...bindings[name], [kind]: value };

  endCapture();
  rebuildLookups();
  persist();
  renderBindings();
}

// Capture runs before the emulator's own handler (see renderer.js, which
// bails out while isCapturing()), and Escape cancels instead of binding --
// otherwise a mis-click would need a rebind to undo.
window.addEventListener(
  'keydown',
  (event) => {
    if (!capturing || capturing.kind !== 'key') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      endCapture();
      renderBindings();
      return;
    }
    assign(capturing.name, 'key', keyName(event));
  },
  true,
);

function pollCapture() {
  if (!capturing || capturing.kind !== 'pad') return;
  const pad = navigator.getGamepads().find((candidate) => candidate && candidate.connected);
  if (!pad) return;
  const index = pad.buttons.findIndex((button) => button.pressed);
  if (index >= 0) assign(capturing.name, 'pad', index);
}

document.getElementById('settings-open').addEventListener('click', () => {
  show('settings');
  renderBindings();
  layoutSelect.value = dsLayout;
  filterSelect.value = imageFilter;
});

document.getElementById('reset-bindings').addEventListener('click', () => {
  bindings = { ...DEFAULT_BINDINGS };
  endCapture();
  rebuildLookups();
  persist();
  renderBindings();
});

// Unlike the layout, this applies at once, over a game already running.
filterSelect.addEventListener('change', () => {
  setImageFilter(filterSelect.value);
  persist();
});

layoutSelect.addEventListener('change', () => {
  dsLayout = layoutSelect.value;
  persist();
  // Takes effect on the next ROM: the canvas and the window are sized when
  // a game is opened.
  document.getElementById('layout-note').hidden = !loadedRom();
});
