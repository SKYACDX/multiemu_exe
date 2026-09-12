const canvas = document.getElementById('screen');
const picker = document.getElementById('picker');
const status = document.getElementById('status');
const ctx = canvas.getContext('2d');

let image = null;

// Path of the ROM currently running, or null. hub.js reads it to know which
// game a cloud save belongs to.
let currentRom = null;

function loadedRom() {
  return currentRom;
}

// Both the DMG and the GBA run at 59.7275Hz, and emulation is paced against
// that rather than tied to vsync: a core whose frame costs more than one
// vsync interval can only start on an interval boundary, which quantises it
// down to refresh/2 or refresh/3 (this cost the Android port 20fps on DS 3D
// before it was found -- see docs/desktop-port-handoff.md section 6).
const FRAME_MS = 1000 / 59.7275;

// Frames to run back-to-back when catching up before writing off the rest of
// the lost time. Without a ceiling, one long stall snowballs into a run of
// hundreds of frames and the window stops responding.
const MAX_CATCHUP = 4;

let due = 0;

function draw() {
  image.data.set(emu.frame());
  ctx.putImageData(image, 0, 0);
}

// ponytail: setTimeout pacing, so ~1ms of jitter per frame. Fine while
// there's no audio; move the clock to a worker if an APU ever needs the
// frames evenly spaced.
function loop() {
  const now = performance.now();
  if (due === 0) due = now;

  let ran = 0;
  while (due <= now && ran < MAX_CATCHUP) {
    emu.runFrame();
    // Drained every frame rather than in batches: the core's own audio
    // queue is only a couple of thousand samples deep, and a frame fills
    // about 800 of them.
    audioPush(emu.readAudio(READ_FRAMES));
    due += FRAME_MS;
    ran++;
  }
  if (due <= now) due = now; // too far behind to catch up; drop the debt

  if (ran > 0) {
    pollGamepad();
    draw();
  }
  setTimeout(loop, Math.max(0, due - performance.now()));
}

// Key -> button name. The preload maps names to each core's own ordinals,
// which differ per console. A button the loaded core doesn't have (L/R on
// Game Boy, X/Y on anything but the DS) is simply ignored there.
// Keys are lowercased before lookup so holding Shift (Select) doesn't turn
// 'x' into 'X' and drop the A button.
const KEYS = {
  arrowright: 'right',
  arrowleft: 'left',
  arrowup: 'up',
  arrowdown: 'down',
  x: 'a',
  z: 'b',
  s: 'x',
  a: 'y',
  q: 'l',
  w: 'r',
  shift: 'select',
  enter: 'start',
};

const toastElement = document.getElementById('toast');
let toastTimer = null;

function toast(text) {
  toastElement.textContent = text;
  toastElement.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
  }, 2000);
}

// Save state on F5, restore on F8 -- kept out of KEYS because they are the
// emulator's own controls, not the console's.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'F5' && event.key !== 'F8') return;
  event.preventDefault();
  const saving = event.key === 'F5';
  if (!(saving ? emu.saveState() : emu.loadState())) {
    toast(saving ? 'Este núcleo no guarda estados' : 'No hay ningún estado guardado');
    return;
  }
  toast(saving ? 'Estado guardado' : 'Estado cargado');
});

for (const [type, pressed] of [['keydown', true], ['keyup', false]]) {
  window.addEventListener(type, (event) => {
    const button = KEYS[event.key.toLowerCase()];
    if (button === undefined) return;
    event.preventDefault(); // arrows would scroll the page otherwise
    audioResume();
    emu.setButton(button, pressed);
  });
}

// ---- Gamepad ----------------------------------------------------------
//
// Indices come from the Gamepad API's "standard" mapping, so any controller
// the browser recognises as standard works without per-pad configuration.
// Face buttons follow the physical Nintendo layout rather than the labels:
// index 0 is the bottom button, which is where A sits on a DS or a GBA.
const PAD_BUTTONS = {
  0: 'a',
  1: 'b',
  2: 'y',
  3: 'x',
  4: 'l',
  5: 'r',
  8: 'select',
  9: 'start',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

// Enough to ignore a resting stick that never quite reads zero.
const STICK_DEADZONE = 0.5;

// Only changes are sent, so a held button isn't re-sent sixty times a
// second -- and so the keyboard and the pad don't fight over the same
// button every frame.
const padState = {};

function pollGamepad() {
  const pad = navigator.getGamepads().find((candidate) => candidate && candidate.connected);
  if (!pad) return;

  const pressed = {};
  for (const [index, name] of Object.entries(PAD_BUTTONS)) {
    if (pad.buttons[index]?.pressed) pressed[name] = true;
  }

  // The left stick doubles as the d-pad; plenty of pads report one and not
  // the other.
  const [x = 0, y = 0] = pad.axes;
  if (x < -STICK_DEADZONE) pressed.left = true;
  if (x > STICK_DEADZONE) pressed.right = true;
  if (y < -STICK_DEADZONE) pressed.up = true;
  if (y > STICK_DEADZONE) pressed.down = true;

  for (const name of new Set([...Object.keys(PAD_BUTTONS).map((i) => PAD_BUTTONS[i]), 'left', 'right', 'up', 'down'])) {
    const down = Boolean(pressed[name]);
    if (padState[name] === down) continue;
    padState[name] = down;
    emu.setButton(name, down);
  }
}

// ---- Touch screen (DS only) ----
//
// The canvas is letterboxed by object-fit: contain, so a click has to be
// mapped back through that fit before it means anything in console pixels.
function canvasPixel(event) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const drawnWidth = canvas.width * scale;
  const drawnHeight = canvas.height * scale;
  return {
    x: Math.floor((event.clientX - (rect.left + (rect.width - drawnWidth) / 2)) / scale),
    y: Math.floor((event.clientY - (rect.top + (rect.height - drawnHeight) / 2)) / scale),
  };
}

// The DS is the only core with a touch screen, and its frame is both
// screens stacked, so the touchable half is always the bottom one.
function sendTouch(event) {
  const { x, y } = canvasPixel(event);
  const topScreenHeight = canvas.height / 2;
  if (x < 0 || x >= canvas.width || y < topScreenHeight || y >= canvas.height) return;
  emu.touch(x, y - topScreenHeight);
}

canvas.addEventListener('mousedown', (event) => {
  audioResume();
  sendTouch(event);
});
canvas.addEventListener('mousemove', (event) => {
  if (event.buttons & 1) sendTouch(event);
});
// On window too, not just the canvas: releasing outside it still has to lift
// the stylus, or the game sees a permanently held touch.
window.addEventListener('mouseup', () => emu.releaseTouch());

function playRom(romPath) {
  let size;
  try {
    size = emu.open(romPath);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  currentRom = romPath;

  canvas.width = size.width;
  canvas.height = size.height;
  image = ctx.createImageData(size.width, size.height);
  audioStart(size.audioSampleRate);

  emu.fitWindow(size);
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  canvas.hidden = false;
  loop();
}

document.getElementById('open').addEventListener('click', async () => {
  const romPath = await emu.pickRom();
  if (romPath) playRom(romPath);
});

if (emu.initialRom) playRom(emu.initialRom);
