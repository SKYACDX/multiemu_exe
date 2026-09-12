const path = require('path');
const { app, BrowserWindow } = require('electron');

// A ROM given on the command line (double-clicking a .gb, or "Open with").
// argv[0] is the executable itself.
const romArgument = process.argv.slice(1).find((argument) => /\.gbc?$/i.test(argument));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 160 * 4,
    height: 144 * 4,
    backgroundColor: '#101010',
    autoHideMenuBar: true, // Electron's default File/Edit/View menu is dead weight here
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The preload needs require() to load the native addon, which the
      // renderer sandbox forbids. contextIsolation stays on (the default),
      // so the renderer still only sees what contextBridge exposes.
      sandbox: false,
      additionalArguments: romArgument ? [`--rom=${romArgument}`] : [],
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
