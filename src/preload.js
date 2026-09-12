const fs = require('fs');
const { contextBridge, ipcRenderer } = require('electron');

const gb = require('../build/Release/gb_addon.node');
const gba = require('../build/Release/gba_addon.node');

// gb::Button (joypad.h) and mGBA's enum GBAKey (mgba/internal/gba/input.h)
// number their buttons differently, so the renderer is given names and this
// file owns the translation. A core without an L/R button simply has no
// entry for it.
const GB_BUTTONS = { right: 0, left: 1, up: 2, down: 3, a: 4, b: 5, select: 6, start: 7 };
const GBA_BUTTONS = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9 };

// One emulator per window. The native object itself can't cross
// contextBridge -- only plain data can -- so it stays here.
let core = null;
let buttons = null;

// Only set for Game Boy. mGBA writes cartridge RAM straight through to the
// save file as the game saves, so there's nothing to do on that side.
let savePath = null;
let lastSaved = null;

// ponytail: polls the save RAM every 5s instead of tracking dirty writes.
// It's at most 32KB. Hook the MBC's writeRam if that ever stops being true.
const SAVE_INTERVAL_MS = 5000;

function persistSave() {
  if (!savePath) return;
  const data = Buffer.from(core.getSave());
  if (lastSaved && lastSaved.equals(data)) return;
  fs.writeFileSync(savePath, data);
  lastSaved = data;
}

function open(romPath) {
  const rom = fs.readFileSync(romPath);
  const sidecar = romPath.replace(/\.[^.]+$/, '.sav');

  if (/\.gba$/i.test(romPath)) {
    // mGBA keeps this file open and writable for the core's lifetime.
    core = new gba.Gba(rom, sidecar);
    buttons = GBA_BUTTONS;
    savePath = null;
  } else {
    core = new gb.GameBoy(rom);
    buttons = GB_BUTTONS;
    savePath = core.hasBattery() ? sidecar : null;
    if (savePath && fs.existsSync(sidecar)) {
      lastSaved = fs.readFileSync(sidecar);
      core.loadSave(lastSaved);
    }
  }

  return { width: core.width, height: core.height };
}

setInterval(() => core && persistSave(), SAVE_INTERVAL_MS);
window.addEventListener('beforeunload', () => core && persistSave());

contextBridge.exposeInMainWorld('emu', {
  // Passed through from the main process's command line (see main.js), so
  // double-clicking a ROM boots straight into it.
  initialRom:
    (process.argv.find((argument) => argument.startsWith('--rom=')) || '').slice('--rom='.length) ||
    null,
  open,
  pickRom: () => ipcRenderer.invoke('pick-rom'),
  runFrame: () => core.runFrame(),
  frame: () => core.frame(),
  setButton: (name, pressed) => {
    const ordinal = buttons[name];
    if (ordinal !== undefined) core.setButton(ordinal, pressed);
  },
});
