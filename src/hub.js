// Everything that talks to RomHack Hub. Lives in the main process on
// purpose: Node's fetch has no CORS to satisfy, and the account token never
// has to cross into the page.
//
// The client itself is not written here -- build/shared.js is the Android
// app's own TypeScript, bundled (see src/shared.ts). This file is only the
// desktop-side plumbing around it: where downloads land, how the token is
// stored, and the IPC surface.
const fs = require('fs');
const path = require('path');
const { Notification, app, ipcMain, safeStorage, shell } = require('electron');

const shared = require('../build/shared.js');

// This build's place in RomHack Hub's versionCode sequence, which is shared
// across platforms rather than per-platform (see docs/app-listing-api.md in
// the shared repo): 10 was Android v1.8, so Windows started at 11.
//
// Read from package.json rather than written here, because it has to match
// the release that gets published or the app offers itself as its own
// update -- which is exactly what happened when the two were kept apart.
// The publish script reads the same field.
const VERSION_CODE = require('../package.json').versionCode;

const DOWNLOAD_PAGE = 'https://www.emulatornds.online/app';

// ROM extensions this app can actually boot, in the order worth preferring
// when a downloaded archive holds more than one.
const ROM_EXTENSIONS = ['nds', 'gba', 'gbc', 'gb'];

function userFile(...parts) {
  const full = path.join(app.getPath('userData'), ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

// ---- Account token ----------------------------------------------------
//
// Kept encrypted with Electron's safeStorage, which hands it to the OS
// keychain rather than inventing a scheme here. Falls back to not
// persisting at all when the OS has no backing store: staying logged in is
// a convenience, and a plaintext bearer token on disk is not a fair price
// for it.
let token = null;
let username = null;

function tokenFile() {
  return userFile('account.bin');
}

function rememberToken(result) {
  token = result.token;
  username = result.username;
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify({ token, username })));
}

function restoreToken() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(tokenFile())) return;
    const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenFile())));
    token = stored.token;
    username = stored.username;
  } catch {
    // A token that won't decrypt (different machine, rotated OS key) is a
    // logged-out user, not an error worth surfacing.
  }
}

// The cloud identity of a cartridge, and it has to match the Android app
// exactly or the two devices never see each other's saves.
//
// Android builds it as `${system}:${romId}` where romId is
// `crc32(bytes).toString(16)` -- see cloudGameKey and LocalLinkScreen in the
// shared repo. Three details that all have to be right:
//
//   - the `<system>:` prefix exists so two consoles' save formats can never
//     collide on one cartridge dump;
//   - the hex is NOT zero-padded, so a CRC starting with a zero nibble
//     would not match a padded one;
//   - the CRC is of the raw ROM, which is why a zipped download and a
//     loose file of the same dump agree.
//
// The local sidecar .sav keeps using the ROM's filename, which is the
// predictable thing on a desktop.
const SYSTEM_BY_EXTENSION = { nds: 'nds', gba: 'gba', gbc: 'gb', gb: 'gb' };

function gameKey(romPath) {
  const extension = path.extname(romPath).slice(1).toLowerCase();
  const system = SYSTEM_BY_EXTENSION[extension] || 'gb';
  return shared.cloudGameKey(system, new Uint8Array(fs.readFileSync(romPath)));
}

function requireToken() {
  if (!token) throw new Error('No has iniciado sesión');
  return token;
}

// ---- Handlers ---------------------------------------------------------

function register() {
  restoreToken();

  ipcMain.handle('hub:files', (event, params) => shared.listFiles(params));

  // Cover art, fetched here and handed over as a data: URL rather than let
  // the page load it directly. A renderer on a file:// origin does not get
  // to pull remote images, so <img src="https://cdn..."> just breaks; the
  // main process has no such restriction. Cached for the session because
  // the same thumbnails come back with every search.
  const covers = new Map();
  ipcMain.handle('hub:cover', async (event, url) => {
    if (!url) return null;
    if (covers.has(url)) return covers.get(url);

    let dataUrl = null;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const type = response.headers.get('content-type') || 'image/jpeg';
        const body = Buffer.from(await response.arrayBuffer());
        dataUrl = `data:${type};base64,${body.toString('base64')}`;
      }
    } catch {
      // A missing cover is a blank square, not an error worth reporting.
    }
    covers.set(url, dataUrl);
    return dataUrl;
  });
  ipcMain.handle('hub:platforms', () => shared.listPlatforms());

  // Downloads one catalogue file and leaves a bootable ROM on disk, then
  // hands back its path. Nearly everything in the catalogue is a zip (under
  // three different mime types, so the archive is detected by trying to
  // unpack it rather than by trusting Content-Type).
  ipcMain.handle('hub:download', async (event, file) => {
    const bytes = await shared.downloadFileBytes(file);

    let romBytes = bytes;
    let name = file.originalName;
    const unpacked = shared.extractFromZip(bytes, ROM_EXTENSIONS);
    if (unpacked) {
      romBytes = unpacked.bytes;
      name = unpacked.name;
    } else if (!ROM_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(`.${ext}`))) {
      throw new Error('El archivo descargado no contiene ninguna ROM que este emulador pueda abrir');
    }

    const romPath = userFile('roms', path.basename(name));
    fs.writeFileSync(romPath, romBytes);
    return romPath;
  });

  // A newer release for THIS platform, or null.
  ipcMain.handle('hub:update-check', async () => {
    const { releases } = await shared.listAppReleases({ limit: 20 });
    return releases.find((release) => release.versionCode > VERSION_CODE && shared.isWindowsRelease(release)) ?? null;
  });

  // The signed download URL in a release expires in five minutes, so the
  // button opens the download page instead of the file: whatever the user
  // clicks there is current no matter how long the notice sat on screen.
  ipcMain.handle('hub:open-download', () => shell.openExternal(DOWNLOAD_PAGE));

  ipcMain.handle('hub:notify-update', (event, version) => {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({
      title: 'multiemu ' + version + ' disponible',
      body: 'Haz clic para ir a la página de descarga.',
    });
    notification.on('click', () => shell.openExternal(DOWNLOAD_PAGE));
    notification.show();
    return true;
  });

  ipcMain.handle('hub:account', () => (token ? { username } : null));

  ipcMain.handle('hub:login', async (event, { email, password }) => {
    try {
      rememberToken(await shared.login(email, password, 'multiemu para Windows'));
    } catch (error) {
      if (error instanceof shared.TotpRequiredError) {
        return { requiresTotp: true, pendingToken: error.pendingToken };
      }
      throw error;
    }
    return { username };
  });

  ipcMain.handle('hub:totp', async (event, { pendingToken, code }) => {
    rememberToken(await shared.verifyTotp(pendingToken, code, 'multiemu para Windows'));
    return { username };
  });

  ipcMain.handle('hub:logout', () => {
    token = null;
    username = null;
    fs.rmSync(tokenFile(), { force: true });
  });

  ipcMain.handle('hub:saves', () => shared.listCloudSaves(requireToken()));

  // The same key uploads use, so the account screen can show just the saves
  // belonging to the game that is open.
  ipcMain.handle('hub:game-key', (event, romPath) => gameKey(romPath));

  // slot -1 is the in-game battery save; 0-3 are whole-machine states.
  // Android reserves exactly this numbering (GAME_SAVE_CLOUD_SLOT = -1), and
  // uploading a battery save to slot 0 -- which this used to do -- would
  // land on top of a save state made on the phone.
  ipcMain.handle('hub:save-upload', async (event, { romPath, savePath, slot, filename }) => {
    if (!fs.existsSync(savePath)) {
      throw new Error('Este juego todavía no ha guardado nada');
    }
    const key = gameKey(romPath);
    const bytes = new Uint8Array(fs.readFileSync(savePath));
    await shared.uploadCloudSave(requireToken(), key, slot, bytes, filename);
    return key;
  });

  ipcMain.handle('hub:save-download', async (event, { id, savePath }) => {
    const bytes = await shared.downloadCloudSave(requireToken(), id);
    fs.writeFileSync(savePath, bytes);
    return savePath;
  });
}

module.exports = { register, VERSION_CODE };
