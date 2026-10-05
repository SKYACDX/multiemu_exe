const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');

const hub = require('./hub');

// A ROM given on the command line (double-clicking a .gb, or "Open with").
// argv[0] is the executable itself.
const romArgument = process.argv.slice(1).find((argument) => /\.(gbc?|gba|nds|3ds|cci|cxi)$/i.test(argument));

// A .zip is offered too, like Android's file picker: the renderer hands it
// to hub:unpack-rom before opening it.
ipcMain.handle('pick-rom', async (event, title, extensions = ['gb', 'gbc', 'gba', 'nds', '3ds', 'cci', 'cxi', 'zip']) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: 'ROMs', extensions }],
  });
  return canceled ? null : filePaths[0];
});

// Android's "Elegir carpeta": the folder whose ROMs the main menu lists.
ipcMain.handle('pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Tu carpeta de ROMs',
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

// A screenshot to attach to a report, with a preview for the form. Android
// caps these at 8MB, which is also what the upload accepts.
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
ipcMain.handle('pick-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Adjuntar captura de pantalla',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: Object.keys(IMAGE_TYPES) }],
  });
  if (canceled) return null;
  const file = filePaths[0];
  const type = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('La imagen pesa más de 8MB, elige una más ligera.');
  return { path: file, name: path.basename(file), preview: `data:${type};base64,${bytes.toString('base64')}` };
});

// Each console has its own shape -- a DS is portrait stacked and landscape
// side by side, the others are neither -- so the window follows whatever was
// loaded instead of guessing.
ipcMain.handle('fit-window', (event, { width, height }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  // Whole-number scale only, so emulator pixels stay square. Bounded by both
  // axes of the actual desktop: the DS side by side is 512 wide, and scaling
  // that on height alone asks for a window wider than the screen.
  const room = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  const scale = Math.max(
    1,
    Math.min(4, Math.floor((room.height * 0.9) / height), Math.floor((room.width * 0.9) / width)),
  );

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

// A cloud save uploading when the window closes gets a few seconds to finish
// rather than being cut off with the process.
let uploadsDone = false;
app.on('before-quit', (event) => {
  if (uploadsDone || !hub.uploading()) return;
  event.preventDefault();
  hub.waitForUploads(8000).finally(() => {
    uploadsDone = true;
    app.quit();
  });
});
