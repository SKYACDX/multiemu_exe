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

// Set while two GBAs are running on the link cable, and which of them the
// keyboard is driving.
let linked = false;
let linkPlayer = 0;

// Null while linked: the cloud-save screen works on one game, and with two
// running it would not be clear which.
function loadedRom() {
  return linked ? null : currentRom;
}

// Both the DMG and the GBA run at 59.7275Hz, and emulation is paced against
// that rather than tied to vsync: a core whose frame costs more than one
// vsync interval can only start on an interval boundary, which quantises it
// down to refresh/2 or refresh/3 (this cost the Android port 20fps on DS 3D
// before it was found -- see docs/desktop-port-handoff.md section 6).
const FRAME_MS = 1000 / 59.7275;

// Frames of debt to work off in one go before writing the rest off. Without
// a ceiling, one long stall snowballs into a run of hundreds of frames and
// the window stops responding.
//
// It scales with speed so it always means the same thing -- four display
// frames' worth. At 4x a fixed ceiling of four would force the loop to wake
// every 4ms to keep up, which is exactly where Chromium clamps nested
// timers, so the speed would quietly fall short of what was asked for.
const MAX_CATCHUP = 4;

let due = 0;

// Frames actually emulated per second, sampled once a second. Asking for 4x
// is not the same as getting it -- the loop is single-threaded and shares
// the thread with drawing -- so the pause menu reports what is really
// happening rather than what was requested.
let framesThisSecond = 0;
let secondStartedAt = 0;
let measuredFps = 0;

// A paused game stays on screen with the menu over it, rather than being
// torn down: resuming has to be instant and keep the save RAM untouched.
let paused = false;

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
  presentFrame();
}

// ponytail: setTimeout pacing, so ~1ms of jitter per frame. The audio queue
// absorbs that (see audio.js, which keeps a lead); move the clock to a
// worker if it ever stops being enough.
function loop(token) {
  if (token !== loopToken) return;

  const now = performance.now();
  if (due === 0) due = now;

  // Linked consoles keep their own time on their own threads, so the speed
  // setting has nothing to act on; resampling their audio by it would only
  // make it sound wrong.
  const rate = linked ? 1 : speed;
  const catchUpLimit = MAX_CATCHUP * rate;

  let ran = 0;
  while (due <= now && ran < catchUpLimit) {
    emu.runFrame();

    // Drained every frame rather than in batches: the core's own audio
    // queue is only a couple of thousand samples deep, and a frame fills
    // about 800 of them. audio.js resamples by the speed, so fast-forward
    // sounds sped up instead of going silent.
    audioPush(emu.readAudio(READ_FRAMES), rate);

    due += FRAME_MS / rate;
    ran++;
  }
  if (due <= now) due = now; // too far behind to catch up; drop the debt

  framesThisSecond += ran;
  if (secondStartedAt === 0) secondStartedAt = now;
  if (now - secondStartedAt >= 1000) {
    measuredFps = Math.round((framesThisSecond * 1000) / (now - secondStartedAt));
    framesThisSecond = 0;
    secondStartedAt = now;
  }

  if (ran > 0) {
    pollGamepad();
    draw();
  }
  setTimeout(() => loop(token), Math.max(0, due - performance.now()));
}

// True while the user is typing into a form control. The emulator has no
// business claiming keys there: Q, W, A, S, Z and X are all bound to
// buttons by default, so without this the login form and the catalogue
// search box silently swallow half the alphabet.
function typingInAField(event) {
  const target = event.target;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

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

// Slot 3 is the automatic one -- see autosave in preload.js.
const AUTO_STATE_SLOT = 3;
const stateSlotName = (slot) => (slot === AUTO_STATE_SLOT ? 'Estado automático' : `Slot ${slot + 1}`);

// Save state on F5, restore on F8 (both slot 1) -- shortcuts for what the
// pause menu also offers, kept out of the bindings because they are the
// emulator's own controls, not the console's.
function saveOrLoadState(saving, slot = 0) {
  if (!(saving ? emu.saveState(slot) : emu.loadState(slot))) {
    toast(saving ? 'Este núcleo no guarda estados' : 'Ese slot está vacío');
    return false;
  }
  toast(`${stateSlotName(slot)} ${saving ? 'guardado' : 'cargado'}`);
  return true;
}

// Tab hands the keyboard (and the pad, and the sound) to the other console.
// Both keep running either way; this only decides which one is listening.
window.addEventListener('keydown', (event) => {
  if (!linked || paused || event.key !== 'Tab' || isCapturing() || typingInAField(event)) return;
  event.preventDefault(); // Tab would move focus otherwise
  linkPlayer = 1 - linkPlayer;
  emu.setPlayer(linkPlayer);
  toast(`Controlas al jugador ${linkPlayer + 1}`);
});

window.addEventListener('keydown', (event) => {
  if (!currentRom || (event.key !== 'F5' && event.key !== 'F8')) return;
  event.preventDefault();
  saveOrLoadState(event.key === 'F5');
});

// keyToButton lives in settings.js, which owns the bindings and the screen
// that edits them. Keys are lowercased there too, so holding Shift (Select)
// doesn't turn 'x' into 'X' and drop the A button.
for (const [type, pressed] of [['keydown', true], ['keyup', false]]) {
  window.addEventListener(type, (event) => {
    // No game means there is no core to talk to, a paused game should not
    // move, a rebind in progress is claiming this keypress, and a focused
    // field owns it outright.
    if (!currentRom || paused || isCapturing() || typingInAField(event)) return;

    const button = keyToButton[event.key.toLowerCase()];
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
  // No core to talk to, or a rebind is claiming the next button press --
  // settings.js polls for that one itself.
  if (!currentRom || paused || isCapturing()) return;

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
// by side. With two DS on a wireless link there are two of them, one per
// console, and a click goes to whichever it lands on. The layout lists them.
function sendTouch(event) {
  const { x, y } = canvasPixel(event);
  for (const area of layout.touchAreas) {
    const touchX = x - area.x;
    const touchY = y - area.y;
    if (touchX < 0 || touchX >= area.width || touchY < 0 || touchY >= area.height) continue;
    emu.touch(touchX, touchY, area.player);
    return;
  }
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

// partnerRom, when given, is the second GBA on a link cable.
function playRom(romPath, partnerRom) {
  let size;
  try {
    size = partnerRom ? emu.openLink(romPath, partnerRom) : emu.open(romPath);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  currentRom = romPath;
  linked = Boolean(partnerRom);
  linkPlayer = 0;

  const screenHeight = size.height / size.screens;
  // Two whole DS consoles side by side, each with its own two screens.
  const dsLink = linked && size.system === 'nds';
  const consoleScreenHeight = dsLink ? screenHeight / 2 : screenHeight;
  // Two players side by side whatever the DS setting says: stacked, each
  // would get half the height for no reason.
  const sideBySide = size.screens === 2 && (linked || dsLayout === 'horizontal');

  canvas.width = sideBySide ? size.width * 2 : size.width;
  canvas.height = sideBySide ? screenHeight : size.height;

  layout = {
    split: sideBySide,
    screenWidth: size.width,
    screenHeight,
    top: ctx.createImageData(size.width, sideBySide ? screenHeight : size.height),
    bottom: sideBySide ? ctx.createImageData(size.width, screenHeight) : null,
    // One console screen, for the image filter to keep apart.
    cellHeight: consoleScreenHeight,
    // Where the touch screens are: the DS's second screen, or on a
    // wireless link the bottom screen of each console.
    touchAreas: dsLink
      ? [0, 1].map((player) => ({
          x: player * size.width, y: consoleScreenHeight, width: size.width, height: consoleScreenHeight, player,
        }))
      : [{
          x: sideBySide ? size.width : 0,
          y: sideBySide ? 0 : screenHeight * (size.screens - 1),
          width: size.width,
          height: screenHeight,
          player: 0,
        }],
  };

  audioStart(size.audioSampleRate);
  emu.fitWindow({ width: canvas.width, height: canvas.height });
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  canvas.hidden = false;
  presentFrame();

  due = 0;
  loop(++loopToken);
  if (linked) toast('Controlas al jugador 1 · Tab cambia de jugador');
  startCloudSync();
}

// Without this there is no way out of a game short of closing the window --
// which also made the cloud-save download unusable, since its own message
// asks the user to reopen the game afterwards.
function stopGame() {
  if (!currentRom) return;
  loopToken++;  // any pending timer now belongs to a dead game
  paused = false;
  currentRom = null;
  linked = false;
  emu.close();
  audioStop();
  canvas.hidden = true;
  presentFrame();
  show('picker');
}

function pauseGame() {
  if (!currentRom || paused) return;
  paused = true;
  loopToken++;  // stops the loop without tearing anything down
  emu.setPaused(true);
  refreshPauseMenu();
  show('pause');
}

function resumeGame() {
  if (!paused) return;
  paused = false;
  emu.setPaused(false);
  secondStartedAt = 0;
  framesThisSecond = 0;
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  due = 0;  // the clock moved on while paused; don't try to catch up on it
  loop(++loopToken);
}

// Escape opens the pause menu rather than quitting outright -- quitting is
// one of the things the menu offers, and it is the destructive one.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !currentRom || isCapturing()) return;
  event.preventDefault();
  if (paused) {
    resumeGame();
  } else {
    pauseGame();
  }
});

// One row of the pause menu's states, laid out like Android's save panel:
// three slots saved by hand, then the automatic one, which can only be
// loaded. Signed in, a slot can also go up to the cloud; bringing one down
// is in the account panel's list.
function stateSlotRow(slot, savedAt) {
  const auto = slot === AUTO_STATE_SLOT;
  const row = element('div', undefined, 'row');
  const label = element('span', `${auto ? 'Automático' : stateSlotName(slot)} · ${
    savedAt ? new Date(savedAt).toLocaleString() : 'vacío'}`);
  label.style.flex = '1';
  row.append(label);

  const button = (text, onClick, disabled = false) => {
    const node = element('button', text);
    node.disabled = disabled;
    node.addEventListener('click', onClick);
    row.append(node);
  };
  if (!auto) {
    button(slot === 0 ? 'Guardar (F5)' : 'Guardar', () => {
      if (saveOrLoadState(true, slot)) refreshPauseMenu();
    });
  }
  button(slot === 0 ? 'Cargar (F8)' : 'Cargar', () => {
    if (saveOrLoadState(false, slot)) resumeGame();
  }, !savedAt);
  if (!auto && signedIn) button('Subir', () => uploadState(slot), !savedAt);
  if (!auto) {
    button('Borrar', () => {
      if (!confirm(`¿Borrar el contenido del slot ${slot + 1}?`)) return;
      emu.deleteState(slot);
      refreshPauseMenu();
    }, !savedAt);
  }
  return row;
}

function refreshPauseMenu() {
  const info = emu.stateInfo();
  document.getElementById('state-info').hidden = info.supported;
  document.getElementById('state-slots').replaceChildren(
    ...(info.supported ? info.slots.map((savedAt, index) => stateSlotRow(index === 3 ? AUTO_STATE_SLOT : index, savedAt)) : []),
  );
  document.getElementById('speed').value = String(speed);
  document.getElementById('speed-note').hidden = speed === 1;
  document.getElementById('fps').textContent = measuredFps
    ? `Va a ${measuredFps} fps, ${(measuredFps / 59.7275).toFixed(1)}x de la velocidad real.`
    : '';
}

document.getElementById('resume').addEventListener('click', resumeGame);
document.getElementById('quit').addEventListener('click', stopGame);


document.getElementById('speed').addEventListener('change', (event) => {
  setSpeed(Number(event.target.value));
  document.getElementById('speed-note').hidden = speed === 1;
});

document.getElementById('pause-settings').addEventListener('click', () => {
  document.getElementById('settings-open').click();
});

document.getElementById('pause-cloud').addEventListener('click', () => {
  document.getElementById('account-open').click();
});

document.getElementById('open').addEventListener('click', async () => {
  const romPath = await emu.pickRom();
  if (romPath) playRom(romPath);
});

document.getElementById('link-open').addEventListener('click', async () => {
  const first = await emu.pickRom('2 jugadores: juego del jugador 1');
  if (!first) return;
  const second = await emu.pickRom('2 jugadores: juego del jugador 2');
  if (second) playRom(first, second);
});

if (emu.initialRom) playRom(emu.initialRom);
