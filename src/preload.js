const fs = require('fs');
const { contextBridge, ipcRenderer } = require('electron');

const gb = require('../build/Release/gb_addon.node');
const gba = require('../build/Release/gba_addon.node');
const ds = require('../build/Release/ds_addon.node');

// Every core numbers its buttons differently -- gb::Button (joypad.h),
// mGBA's enum GBAKey, and the DS's own KeyInput order -- so the renderer is
// given names and this file owns the translation. A core without a given
// button simply has no entry for it, and pressing it does nothing.
const GB_BUTTONS = { right: 0, left: 1, up: 2, down: 3, a: 4, b: 5, select: 6, start: 7 };
const GBA_BUTTONS = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9 };
const DS_BUTTONS = { ...GBA_BUTTONS, x: 10, y: 11 };

function argument(name) {
  const prefix = `--${name}=`;
  return (process.argv.find((value) => value.startsWith(prefix)) || '').slice(prefix.length) || null;
}

// Where melonDS keeps its firmware image, which is what makes the DS's own
// settings outlive a session. Has to be set before any DS instance exists.
const userDataDir = argument('userdata');
if (userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  ds.setLocalDir(userDataDir);
}

// One emulator per window. The native object itself can't cross
// contextBridge -- only plain data can -- so it stays here.
let core = null;
let buttons = null;

// Only set for Game Boy. mGBA and melonDS both write cartridge RAM straight
// through to the save file as the game saves, so those two need nothing.
let savePath = null;
let lastSaved = null;

// Whole-machine snapshot, next to the ROM like the .sav. Null for a core
// that can't take one -- core/gb has no savestate support.
let statePath = null;

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
  const sidecar = romPath.replace(/\.[^.]+$/, '.sav');
  savePath = null;
  statePath = romPath.replace(/\.[^.]+$/, '.state');

  if (/\.nds$/i.test(romPath)) {
    // By path rather than by bytes: NDS images run to 512MB.
    core = new ds.Ds(romPath, sidecar);
    buttons = DS_BUTTONS;
  } else if (/\.gba$/i.test(romPath)) {
    core = new gba.Gba(fs.readFileSync(romPath), sidecar);
    buttons = GBA_BUTTONS;
  } else {
    core = new gb.GameBoy(fs.readFileSync(romPath));
    buttons = GB_BUTTONS;
    if (core.hasBattery()) {
      savePath = sidecar;
      if (fs.existsSync(sidecar)) {
        lastSaved = fs.readFileSync(sidecar);
        core.loadSave(lastSaved);
      }
    }
  }

  // audioSampleRate is absent on a core with no APU -- core/gb doesn't
  // implement one yet, so Game Boy is silent.
  return { width: core.width, height: core.height, audioSampleRate: core.audioSampleRate || 0 };
}

setInterval(() => core && persistSave(), SAVE_INTERVAL_MS);
window.addEventListener('beforeunload', () => core && persistSave());

// Everything RomHack Hub, forwarded to the main process -- see src/hub.js
// for why it lives there rather than here.
contextBridge.exposeInMainWorld('hub', {
  platforms: () => ipcRenderer.invoke('hub:platforms'),
  files: (params) => ipcRenderer.invoke('hub:files', params),
  cover: (url) => ipcRenderer.invoke('hub:cover', url),
  download: (file) => ipcRenderer.invoke('hub:download', file),
  updateCheck: () => ipcRenderer.invoke('hub:update-check'),
  account: () => ipcRenderer.invoke('hub:account'),
  login: (credentials) => ipcRenderer.invoke('hub:login', credentials),
  totp: (challenge) => ipcRenderer.invoke('hub:totp', challenge),
  logout: () => ipcRenderer.invoke('hub:logout'),
  saves: () => ipcRenderer.invoke('hub:saves'),
  uploadSave: (params) => ipcRenderer.invoke('hub:save-upload', params),
  downloadSave: (params) => ipcRenderer.invoke('hub:save-download', params),
});

contextBridge.exposeInMainWorld('emu', {
  // Passed through from the main process's command line (see main.js), so
  // double-clicking a ROM boots straight into it.
  initialRom: argument('rom'),
  open,
  pickRom: () => ipcRenderer.invoke('pick-rom'),
  fitWindow: (size) => ipcRenderer.invoke('fit-window', size),
  runFrame: () => core.runFrame(),
  frame: () => core.frame(),
  setButton: (name, pressed) => {
    const ordinal = buttons[name];
    if (ordinal !== undefined) core.setButton(ordinal, pressed);
  },
  readAudio: (frames) => (core.readAudio ? core.readAudio(frames) : new Int16Array(0)),
  // ponytail: one state per game, not numbered slots. The Android app has
  // slots; add them here when someone actually wants a second one.
  saveState: () => {
    if (!core.saveState || !statePath) return false;
    fs.writeFileSync(statePath, Buffer.from(core.saveState()));
    return true;
  },
  loadState: () => {
    if (!core.loadState || !statePath || !fs.existsSync(statePath)) return false;
    return core.loadState(new Uint8Array(fs.readFileSync(statePath)));
  },
  // No-ops on the cores with no touch screen.
  touch: (x, y) => core.touch && core.touch(x, y),
  releaseTouch: () => core.releaseTouch && core.releaseTouch(),
});
