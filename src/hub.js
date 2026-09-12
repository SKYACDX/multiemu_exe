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
const { app, ipcMain, safeStorage } = require('electron');

const shared = require('../build/shared.js');

// This build's place in RomHack Hub's versionCode sequence, which is shared
// across platforms rather than per-platform: 10 is Android v1.8, so the
// first Windows release is 11 (see docs/app-listing-api.md in the shared
// repo). Bump it on every published release.
const VERSION_CODE = 11;

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

// The cloud key is the ROM's CRC32, not its filename: that is how the
// Android app names its own save files, so the same cartridge lines up
// across devices no matter what the file was called when it was downloaded.
// The local sidecar .sav keeps using the ROM's name, which is the
// predictable thing on a desktop.
function gameKey(romPath) {
  return shared.crc32(new Uint8Array(fs.readFileSync(romPath))).toString(16).padStart(8, '0');
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
    const { releases } = await shared.listAppReleases({ platform: 'windows', limit: 10 });
    const newer = releases.find(
      // The platform filter is applied again here rather than trusted: the
      // query parameter is accepted but does not filter today, and existing
      // releases report platform as null. An unlabelled release is treated
      // as "not ours" so an Android build never offers itself as a Windows
      // update -- which also means this stays quiet until the backend
      // starts reporting the field, with no change needed here.
      (release) => String(release.platform).toUpperCase() === 'WINDOWS' && release.versionCode > VERSION_CODE,
    );
    return newer ?? null;
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

  ipcMain.handle('hub:save-upload', async (event, { romPath, savePath, slot }) => {
    if (!fs.existsSync(savePath)) {
      throw new Error('Este juego todavía no ha guardado nada');
    }
    const key = gameKey(romPath);
    const bytes = new Uint8Array(fs.readFileSync(savePath));
    await shared.uploadCloudSave(requireToken(), key, slot ?? 0, bytes, path.basename(savePath));
    return key;
  });

  ipcMain.handle('hub:save-download', async (event, { id, savePath }) => {
    const bytes = await shared.downloadCloudSave(requireToken(), id);
    fs.writeFileSync(savePath, bytes);
    return savePath;
  });
}

module.exports = { register, VERSION_CODE };
