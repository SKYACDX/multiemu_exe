const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

const hub = require('./hub');

// A ROM given on the command line (double-clicking a .gb, or "Open with").
// argv[0] is the executable itself.
const romArgument = process.argv.slice(1).find((argument) => /\.(gbc?|gba|nds)$/i.test(argument));

ipcMain.handle('pick-rom', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ROMs', extensions: ['gb', 'gbc', 'gba', 'nds'] }],
  });
  return canceled ? null : filePaths[0];
});

// Each console has its own shape -- the DS is portrait, the others are not
// -- so the window follows whatever ROM was loaded instead of guessing.
ipcMain.handle('fit-window', (event, { width, height }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  // Whole-number scale only, so emulator pixels stay square.
  const scale = Math.max(1, Math.min(4, Math.floor(900 / height)));
  win.setContentSize(width * scale, height * scale);
  win.center();
});

app.whenReady().then(() => {
  hub.register();

  const win = new BrowserWindow({
    width: 240 * 3,
    height: 160 * 3,
    backgroundColor: '#101010',
    autoHideMenuBar: true, // Electron's default File/Edit/View menu is dead weight here
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The preload needs require() to load the native addons, which the
      // renderer sandbox forbids. contextIsolation stays on (the default),
      // so the renderer still only sees what contextBridge exposes.
      sandbox: false,
      additionalArguments: [
        // melonDS keeps its firmware image here, which is what makes the
        // DS's own settings (including Nintendo WFC) outlive a session.
        `--userdata=${app.getPath('userData')}`,
        ...(romArgument ? [`--rom=${romArgument}`] : []),
      ],
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
