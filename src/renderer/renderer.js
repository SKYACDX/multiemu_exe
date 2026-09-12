const canvas = document.getElementById('screen');
const picker = document.getElementById('picker');
const status = document.getElementById('status');
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(gb.width, gb.height);

// The DMG's real frame rate, not the display's. Emulation is paced against
// this and never tied to vsync: a core whose frame costs more than one
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
  image.data.set(gb.frame());
  ctx.putImageData(image, 0, 0);
}

// ponytail: setTimeout pacing, so ~1ms of jitter per frame. Fine while
// there's no audio; move the clock to a worker if the APU ever needs the
// frames evenly spaced.
function loop() {
  const now = performance.now();
  if (due === 0) due = now;

  let ran = 0;
  while (due <= now && ran < MAX_CATCHUP) {
    gb.runFrame();
    due += FRAME_MS;
    ran++;
  }
  if (due <= now) due = now; // too far behind to catch up; drop the debt

  if (ran > 0) draw();
  setTimeout(loop, Math.max(0, due - performance.now()));
}

// gb::Button ordinals (joypad.h): 0=Right 1=Left 2=Up 3=Down 4=A 5=B
// 6=Select 7=Start. Keys are lowercased before lookup so holding Shift
// (Select) doesn't turn 'x' into 'X' and drop the A button.
const KEYS = {
  arrowright: 0,
  arrowleft: 1,
  arrowup: 2,
  arrowdown: 3,
  x: 4,
  z: 5,
  shift: 6,
  enter: 7,
};

for (const [type, pressed] of [['keydown', true], ['keyup', false]]) {
  window.addEventListener(type, (event) => {
    const button = KEYS[event.key.toLowerCase()];
    if (button === undefined) return;
    event.preventDefault(); // arrows would scroll the page otherwise
    gb.setButton(button, pressed);
  });
}

function start(load) {
  try {
    load();
  } catch (error) {
    status.textContent = error.message;
    return;
  }

  picker.hidden = true;
  canvas.hidden = false;
  loop();
}

document.getElementById('rom').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const rom = new Uint8Array(await file.arrayBuffer());
  start(() => gb.load(rom));
});

if (gb.initialRom) start(() => gb.loadPath(gb.initialRom));
