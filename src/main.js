const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');

// A ROM given on the command line (double-clicking a .gb, or "Open with").
// argv[0] is the executable itself.
const romArgument = process.argv.slice(1).find((argument) => /\.(gbc?|gba)$/i.test(argument));

ipcMain.handle('pick-rom', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ROMs', extensions: ['gb', 'gbc', 'gba'] }],
  });
  return canceled ? null : filePaths[0];
});

app.whenReady().then(() => {
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
      additionalArguments: romArgument ? [`--rom=${romArgument}`] : [],
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
