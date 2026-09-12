const fs = require('fs');
const { contextBridge } = require('electron');
const addon = require('../build/Release/gb_addon.node');

// One emulator instance per window, held here rather than in the renderer:
// the native object itself can't cross contextBridge, only plain data can.
let gameBoy = null;

contextBridge.exposeInMainWorld('gb', {
  width: addon.SCREEN_WIDTH,
  height: addon.SCREEN_HEIGHT,
  // Passed through from the main process's command line (see main.js), so
  // double-clicking a .gb boots straight into it.
  initialRom: (process.argv.find((argument) => argument.startsWith('--rom=')) || '')
    .slice('--rom='.length) || null,
  load: (rom) => {
    gameBoy = new addon.GameBoy(rom);
  },
  loadPath: (file) => {
    gameBoy = new addon.GameBoy(fs.readFileSync(file));
  },
  runFrame: () => gameBoy.runFrame(),
  frame: () => gameBoy.frame(),
  setButton: (id, pressed) => gameBoy.setButton(id, pressed),
});
