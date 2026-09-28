const fs = require('fs');
const path = require('path');
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

// Controls and screen layout, in a plain JSON file next to the saves rather
// than in localStorage: it sits with everything else the app writes, and a
// user who wants to hand-edit a binding can. No IPC needed -- the preload
// already has both fs and the directory.
const settingsPath = userDataDir ? path.join(userDataDir, 'settings.json') : null;

function readSettings() {
  try {
    // Strip a leading BOM: the file is documented as hand-editable, and
    // plenty of Windows editors write UTF-8 with one. JSON.parse rejects it,
    // which would silently throw away every binding the user had set.
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // Missing on a first run, and unreadable if someone hand-edits it into
    // invalid JSON. Either way the defaults are the right answer.
    return {};
  }
}

function writeSettings(settings) {
  if (!settingsPath) return;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// One emulator per window. The native object itself can't cross
// contextBridge -- only plain data can -- so it stays here.
let core = null;
let buttons = null;

// Game Boy battery saves, which this file writes itself -- mGBA and melonDS
// write cartridge RAM straight through to the save file as the game saves,
// so those two need nothing. One entry for a console, two for a linked
// pair: { path, last (the bytes last written), read () -> current bytes }.
let batterySaves = [];

// Whole-machine snapshot, next to the ROM like the .sav. Whether the loaded
// core can actually take one is a separate question -- core/gb can't yet, so
// saveState/loadState below check for the method rather than for this.
let statePath = null;

// ponytail: polls the save RAM every 5s instead of tracking dirty writes.
// It's at most 32KB. Hook the MBC's writeRam if that ever stops being true.
const SAVE_INTERVAL_MS = 5000;

function persistSave() {
  for (const save of batterySaves) {
    const data = Buffer.from(save.read());
    if (save.last && save.last.equals(data)) continue;
    fs.writeFileSync(save.path, data);
    save.last = data;
  }
}

// Starts tracking one Game Boy battery save, loading what is already on
// disk into the console first.
function trackBatterySave(path, read, load) {
  const save = { path, last: null, read };
  if (fs.existsSync(path)) {
    save.last = fs.readFileSync(path);
    load(save.last);
  }
  batterySaves.push(save);
}

function open(romPath) {
  const sidecar = romPath.replace(/\.[^.]+$/, '.sav');
  // Reset, or the next game's save RAM gets compared against the previous
  // game's bytes and a write that should happen can be skipped.
  batterySaves = [];
  statePath = romPath.replace(/\.[^.]+$/, '.state');
  ranSinceAutosave = false;

  let screens = 1;
  if (/\.nds$/i.test(romPath)) {
    // By path rather than by bytes: NDS images run to 512MB.
    core = new ds.Ds(romPath, sidecar);
    buttons = DS_BUTTONS;
    // The DS hands over both screens in one frame, stacked. Saying so lets
    // the renderer lay them out side by side instead.
    screens = 2;
  } else if (/\.gba$/i.test(romPath)) {
    core = new gba.Gba(fs.readFileSync(romPath), sidecar);
    buttons = GBA_BUTTONS;
  } else {
    core = new gb.GameBoy(fs.readFileSync(romPath));
    buttons = GB_BUTTONS;
    if (core.hasBattery()) {
      trackBatterySave(sidecar, () => core.getSave(), (bytes) => core.loadSave(bytes));
    }
  }

  // All three cores report 48000; the fallback is for a core that has no
  // APU at all, which would make audioStart a no-op rather than a crash.
  return {
    width: core.width,
    height: core.height,
    screens,
    audioSampleRate: core.audioSampleRate || 0,
  };
}

function systemOf(romPath) {
  if (/\.nds$/i.test(romPath)) return 'nds';
  if (/\.gba$/i.test(romPath)) return 'gba';
  if (/\.gbc?$/i.test(romPath)) return 'gb';
  return null;
}

// Two consoles connected: a link cable for GBA (GbaLink in gba_addon.cpp),
// local wireless for DS (DsLink in ds_addon.cpp). Each keeps its own save
// next to its own ROM, written through by its own core -- which is why they
// cannot share one: two writers on the same .sav would corrupt it.
function openLink(romA, romB) {
  const system = systemOf(romA);
  if (!system || system !== systemOf(romB)) {
    throw new Error('Los dos juegos tienen que ser de la misma consola: dos de DS, dos de GBA o dos de Game Boy.');
  }
  const saveA = romA.replace(/\.[^.]+$/, '.sav');
  const saveB = romB.replace(/\.[^.]+$/, '.sav');
  // Windows paths are case-insensitive, so compare them that way.
  if (path.resolve(saveA).toLowerCase() === path.resolve(saveB).toLowerCase()) {
    throw new Error(
      'Los dos jugadores no pueden usar la misma ROM: compartirían la partida guardada. ' +
        'Para intercambiar entre dos partidas del mismo juego, haz una copia de la ROM con otro nombre.',
    );
  }
  batterySaves = [];
  if (system === 'nds') {
    // By path, like a single DS: images run to 512MB.
    core = new ds.DsLink(romA, saveA, romB, saveB);
    buttons = DS_BUTTONS;
  } else if (system === 'gba') {
    core = new gba.GbaLink(fs.readFileSync(romA), saveA, fs.readFileSync(romB), saveB);
    buttons = GBA_BUTTONS;
  } else {
    core = new gb.GbLink(fs.readFileSync(romA), fs.readFileSync(romB));
    buttons = GB_BUTTONS;
    [saveA, saveB].forEach((path, player) => {
      if (!core.hasBattery(player)) return;
      trackBatterySave(path, () => core.getSave(player), (bytes) => core.loadSave(player, bytes));
    });
  }
  statePath = null;
  return { width: core.width, height: core.height, screens: 2, audioSampleRate: core.audioSampleRate, system };
}

// Through a temp file: dying halfway through a write must not leave a
// truncated state where the last good one was.
function writeState(target) {
  fs.writeFileSync(target + '.tmp', Buffer.from(core.saveState()));
  fs.renameSync(target + '.tmp', target);
}

// The Android app's automatic slot (AUTOSAVE_SLOT in App.tsx): a state
// written every 45s and whenever the window is hidden or closed, so a crash
// or a killed process costs at most that much. Only once the game has run
// since the last one, or reopening the game and not touching it would
// write its title screen over the state it was meant to recover.
const AUTOSAVE_INTERVAL_MS = 45_000;
let ranSinceAutosave = false;
const autoStatePath = () => statePath && statePath.replace(/\.state$/, '.auto.state');

function autosave() {
  if (!core || !core.saveState || !statePath || !ranSinceAutosave) return;
  try {
    writeState(autoStatePath());
    ranSinceAutosave = false;
  } catch {
    // Best effort, like Android's: nobody asked for this one.
  }
}

setInterval(() => core && persistSave(), SAVE_INTERVAL_MS);
setInterval(autosave, AUTOSAVE_INTERVAL_MS);
document.addEventListener('visibilitychange', () => document.hidden && autosave());
window.addEventListener('beforeunload', () => {
  if (!core) return;
  persistSave();
  autosave();
});

// Everything RomHack Hub, forwarded to the main process -- see src/hub.js
// for why it lives there rather than here.
contextBridge.exposeInMainWorld('hub', {
  platforms: () => ipcRenderer.invoke('hub:platforms'),
  files: (params) => ipcRenderer.invoke('hub:files', params),
  cover: (url) => ipcRenderer.invoke('hub:cover', url),
  download: (file) => ipcRenderer.invoke('hub:download', file),
  updateCheck: () => ipcRenderer.invoke('hub:update-check'),
  openDownload: () => ipcRenderer.invoke('hub:open-download'),
  installUpdate: () => ipcRenderer.invoke('hub:update-install'),
  onUpdateProgress: (callback) => ipcRenderer.on('hub:update-progress', (event, percent) => callback(percent)),
  notifyUpdate: (version) => ipcRenderer.invoke('hub:notify-update', version),
  account: () => ipcRenderer.invoke('hub:account'),
  login: (credentials) => ipcRenderer.invoke('hub:login', credentials),
  totp: (challenge) => ipcRenderer.invoke('hub:totp', challenge),
  logout: () => ipcRenderer.invoke('hub:logout'),
  saves: () => ipcRenderer.invoke('hub:saves'),
  gameKey: (romPath) => ipcRenderer.invoke('hub:game-key', romPath),
  uploadSave: (params) => ipcRenderer.invoke('hub:save-upload', params),
  downloadSave: (params) => ipcRenderer.invoke('hub:save-download', params),
});

contextBridge.exposeInMainWorld('settings', {
  read: readSettings,
  write: writeSettings,
});

contextBridge.exposeInMainWorld('emu', {
  // Passed through from the main process's command line (see main.js), so
  // double-clicking a ROM boots straight into it.
  initialRom: argument('rom'),
  open,
  openLink,
  pickRom: (title) => ipcRenderer.invoke('pick-rom', title),
  fitWindow: (size) => ipcRenderer.invoke('fit-window', size),
  runFrame: () => {
    ranSinceAutosave = true;
    return core.runFrame();
  },
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
    writeState(statePath);
    return true;
  },
  // What the pause menu shows about the saved states: whether this core can
  // take one at all, and when the manual and the automatic one were written.
  stateInfo: () => {
    const supported = Boolean(core && core.saveState && statePath);
    const savedAt = (file) =>
      supported && fs.existsSync(file) ? fs.statSync(file).mtime.toISOString() : null;
    return { supported, savedAt: savedAt(statePath), autoSavedAt: savedAt(autoStatePath()) };
  },
  // auto picks the automatic state over the one saved by hand.
  loadState: (auto) => {
    const file = auto ? autoStatePath() : statePath;
    if (!core.loadState || !file || !fs.existsSync(file)) return false;
    return core.loadState(new Uint8Array(fs.readFileSync(file)));
  },
  // Link cable only: which console the keyboard, pad and speakers belong
  // to, and holding both consoles still while the pause menu is open --
  // they run on threads of their own, so stopping the loop here would not.
  setPlayer: (player) => core.setPlayer && core.setPlayer(player),
  setPaused: (paused) => core && core.setPaused && core.setPaused(paused),
  // No-ops on the cores with no touch screen.
  // player picks the console on a DS wireless link; a single DS ignores it.
  touch: (x, y, player) => core.touch && core.touch(x, y, player),
  releaseTouch: () => core.releaseTouch && core.releaseTouch(),
  // Called when a game is closed: the Game Boy save is otherwise only
  // written on a timer and at exit, so up to five seconds would be lost.
  close: () => {
    persistSave();
    autosave();
    // Explicit, not just dropping the reference: the native wrapper would
    // otherwise live until the garbage collector ran, and with it mGBA's
    // open handle on the save file.
    if (core && core.close) core.close();
    core = null;
    buttons = null;
    batterySaves = [];
    statePath = null;
  },
});
