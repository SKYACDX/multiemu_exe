const canvas = document.getElementById('screen');
const picker = document.getElementById('picker');
const status = document.getElementById('status');
const ctx = canvas.getContext('2d');

// How the frame the core hands over maps onto the canvas. The DS produces
// its two screens stacked; drawing them side by side is just a matter of
// putting the second half somewhere else, with no scaling involved.
let layout = null;

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

// Bumped every time a game starts or stops, so a setTimeout left over from
// the previous game stops itself instead of running a second emulation loop
// alongside the new one.
let loopToken = 0;

function draw() {
  const frame = emu.frame();
  if (layout.split) {
    const half = frame.length / 2;
    layout.top.data.set(frame.subarray(0, half));
    layout.bottom.data.set(frame.subarray(half));
    ctx.putImageData(layout.top, 0, 0);
    ctx.putImageData(layout.bottom, layout.screenWidth, 0);
  } else {
    layout.top.data.set(frame);
    ctx.putImageData(layout.top, 0, 0);
  }
}

// ponytail: setTimeout pacing, so ~1ms of jitter per frame. The audio queue
// absorbs that (see audio.js, which keeps a lead); move the clock to a
// worker if it ever stops being enough.
function loop(token) {
  if (token !== loopToken) return;

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
  setTimeout(() => loop(token), Math.max(0, due - performance.now()));
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
// The index -> button table is padToButton, owned by settings.js.

// Enough to ignore a resting stick that never quite reads zero.
const STICK_DEADZONE = 0.5;

// Every name a pad can drive, whatever it happens to be bound to.
const PAD_NAMES = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'select', 'start'];

// Only changes are sent, so a held button isn't re-sent sixty times a
// second -- and so the keyboard and the pad don't fight over the same
// button every frame.
const padState = {};

function pollGamepad() {
  // A rebind in progress wants the next button press for itself.
  if (isCapturing()) {
    pollCapture();
    return;
  }

  const pad = navigator.getGamepads().find((candidate) => candidate && candidate.connected);
  if (!pad) return;

  const pressed = {};
  for (const [index, name] of Object.entries(padToButton)) {
    if (pad.buttons[index]?.pressed) pressed[name] = true;
  }

  // The left stick doubles as the d-pad; plenty of pads report one and not
  // the other.
  const [x = 0, y = 0] = pad.axes;
  if (x < -STICK_DEADZONE) pressed.left = true;
  if (x > STICK_DEADZONE) pressed.right = true;
  if (y < -STICK_DEADZONE) pressed.up = true;
  if (y > STICK_DEADZONE) pressed.down = true;

  for (const name of PAD_NAMES) {
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

// The DS is the only core with a touch screen, and it is always the second
// of its two screens -- below the first when stacked, to its right when side
// by side. The layout says where that lands on the canvas.
function sendTouch(event) {
  const { x, y } = canvasPixel(event);
  const touchX = x - layout.touchX;
  const touchY = y - layout.touchY;
  if (touchX < 0 || touchX >= layout.screenWidth) return;
  if (touchY < 0 || touchY >= layout.screenHeight) return;
  emu.touch(touchX, touchY);
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

  const screenHeight = size.height / size.screens;
  const sideBySide = size.screens === 2 && dsLayout === 'horizontal';

  canvas.width = sideBySide ? size.width * 2 : size.width;
  canvas.height = sideBySide ? screenHeight : size.height;

  layout = {
    split: sideBySide,
    screenWidth: size.width,
    screenHeight,
    top: ctx.createImageData(size.width, sideBySide ? screenHeight : size.height),
    bottom: sideBySide ? ctx.createImageData(size.width, screenHeight) : null,
    // Where the second screen starts, which for the DS is the touchable one.
    touchX: sideBySide ? size.width : 0,
    touchY: sideBySide ? 0 : screenHeight * (size.screens - 1),
  };

  audioStart(size.audioSampleRate);
  emu.fitWindow({ width: canvas.width, height: canvas.height });
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  canvas.hidden = false;

  due = 0;
  loop(++loopToken);
}

// Without this there is no way out of a game short of closing the window --
// which also made the cloud-save download unusable, since its own message
// asks the user to reopen the game afterwards.
function stopGame() {
  if (!currentRom) return;
  loopToken++;  // any pending timer now belongs to a dead game
  currentRom = null;
  emu.close();
  audioStop();
  canvas.hidden = true;
  picker.hidden = false;
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  stopGame();
});

document.getElementById('open').addEventListener('click', async () => {
  const romPath = await emu.pickRom();
  if (romPath) playRom(romPath);
});

if (emu.initialRom) playRom(emu.initialRom);
