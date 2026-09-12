const canvas = document.getElementById('screen');
const picker = document.getElementById('picker');
const status = document.getElementById('status');
const ctx = canvas.getContext('2d');

let image = null;

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
    due += FRAME_MS;
    ran++;
  }
  if (due <= now) due = now; // too far behind to catch up; drop the debt

  if (ran > 0) draw();
  setTimeout(loop, Math.max(0, due - performance.now()));
}

// Key -> button name. The preload maps names to each core's own ordinals,
// which are not the same between GB and GBA. L/R have no effect on GB.
// Keys are lowercased before lookup so holding Shift (Select) doesn't turn
// 'x' into 'X' and drop the A button.
const KEYS = {
  arrowright: 'right',
  arrowleft: 'left',
  arrowup: 'up',
  arrowdown: 'down',
  x: 'a',
  z: 'b',
  shift: 'select',
  enter: 'start',
  a: 'l',
  s: 'r',
};

for (const [type, pressed] of [['keydown', true], ['keyup', false]]) {
  window.addEventListener(type, (event) => {
    const button = KEYS[event.key.toLowerCase()];
    if (button === undefined) return;
    event.preventDefault(); // arrows would scroll the page otherwise
    emu.setButton(button, pressed);
  });
}

function start(romPath) {
  let size;
  try {
    size = emu.open(romPath);
  } catch (error) {
    status.textContent = error.message;
    return;
  }

  canvas.width = size.width;
  canvas.height = size.height;
  image = ctx.createImageData(size.width, size.height);

  picker.hidden = true;
  canvas.hidden = false;
  loop();
}

document.getElementById('open').addEventListener('click', async () => {
  const romPath = await emu.pickRom();
  if (romPath) start(romPath);
});

if (emu.initialRom) start(emu.initialRom);
