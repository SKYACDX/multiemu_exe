// Everything that talks to RomHack Hub. Lives in the main process on
// purpose: Node's fetch has no CORS to satisfy, and the account token never
// has to cross into the page.
//
// The client itself is not written here -- build/shared.js is the Android
// app's own TypeScript, bundled (see src/shared.ts). This file is only the
// desktop-side plumbing around it: where downloads land, how the token is
// stored, and the IPC surface.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { BrowserWindow, Notification, app, dialog, ipcMain, safeStorage, shell } = require('electron');

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
const ROM_EXTENSIONS = ['3ds', 'cci', 'cxi', 'nds', 'gba', 'gbc', 'gb'];

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
const SYSTEM_BY_EXTENSION = { '3ds': '3ds', cci: '3ds', cxi: '3ds', nds: 'nds', gba: 'gba', gbc: 'gb', gb: 'gb' };

function gameKey(romPath) {
  const extension = path.extname(romPath).slice(1).toLowerCase();
  const system = SYSTEM_BY_EXTENSION[extension] || 'gb';
  return shared.cloudGameKey(system, new Uint8Array(fs.readFileSync(romPath)));
}

// ---- Pictures taken from the games themselves ----------------------------
//
// What the menu and the background behind the game show, taken from the
// game rather than looked up anywhere: a DS ROM carries its own icon, the
// one the console's menu shows, and that is drawn out of it. A Game Boy or
// GBA ROM carries no picture at all, so its picture is its own screen --
// the last one seen when the game was left (saved by the preload's
// saveScreen), and the live one behind it while it runs (the renderer's
// ambient canvas).

// The ROM inside a file: the file itself, or the first ROM in a .zip.
// { extension, zipped, dataStart, stored }, or null for a zip holding no
// ROM this walk can find -- it follows the local file headers, which stops
// at an entry whose size comes after its data (flag bit 3).
function romEntry(romPath) {
  const extension = path.extname(romPath).slice(1).toLowerCase();
  if (extension !== 'zip') return { extension, zipped: false };
  const file = fs.openSync(romPath, 'r');
  try {
    let offset = 0;
    for (let entry = 0; entry < 16; entry++) {
      const local = Buffer.alloc(30);
      if (fs.readSync(file, local, 0, 30, offset) < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
      const nameLength = local.readUInt16LE(26);
      const name = Buffer.alloc(nameLength);
      fs.readSync(file, name, 0, nameLength, offset + 30);
      const dataStart = offset + 30 + nameLength + local.readUInt16LE(28);
      const inner = path.extname(name.toString()).slice(1).toLowerCase();
      if (ROM_EXTENSIONS.includes(inner)) {
        return { extension: inner, zipped: true, dataStart, stored: local.readUInt16LE(8) === 0 };
      }
      if (local.readUInt16LE(6) & 8) return null;
      offset = dataStart + local.readUInt32LE(18);
    }
    return null;
  } finally {
    fs.closeSync(file);
  }
}

// length bytes of the ROM from offset on. Inside a zip the entry is
// inflated as a stream and dropped the moment the range is covered, so a
// 512MB DS image is never unpacked to read a few KB near its start.
function readRomRange(romPath, entry, offset, length) {
  if (!entry.zipped) {
    const bytes = Buffer.alloc(length);
    const file = fs.openSync(romPath, 'r');
    try {
      fs.readSync(file, bytes, 0, length, offset);
    } finally {
      fs.closeSync(file);
    }
    return Promise.resolve(bytes);
  }
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(romPath, { start: entry.dataStart });
    const source = entry.stored ? input : input.pipe(zlib.createInflateRaw());
    const end = offset + length;
    const parts = [];
    let seen = 0;
    const finish = () => {
      input.destroy();
      source.destroy();
      resolve(Buffer.concat(parts));
    };
    source.on('data', (chunk) => {
      const from = Math.max(0, offset - seen);
      const to = Math.min(chunk.length, end - seen);
      if (to > from) parts.push(chunk.subarray(from, to));
      seen += chunk.length;
      if (seen >= end) finish();
    });
    source.on('end', finish);
    source.on('error', reject);
    input.on('error', reject);
  });
}

// A minimal PNG of an RGBA image: one IHDR, one IDAT, no filtering.
function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A DS ROM's icon as PNG bytes, or null. The banner's offset is in the
// header at 0x68; in the banner, the 32x32 icon is 4x4 tiles of 8x8 at
// 4 bits a pixel from 0x20, and its 16-colour BGR555 palette follows at
// 0x220, colour 0 being transparent (GBATEK, "DS Cartridge Icon/Title").
async function dsIcon(romPath, entry) {
  const header = await readRomRange(romPath, entry, 0, 0x200);
  const banner = header.readUInt32LE(0x68);
  if (!banner) return null;
  const data = await readRomRange(romPath, entry, banner + 0x20, 0x220);
  if (data.length < 0x220) return null;
  const rgba = Buffer.alloc(32 * 32 * 4);
  const expand = (c) => (c << 3) | (c >> 2);
  for (let tile = 0; tile < 16; tile++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const byte = data[tile * 32 + y * 4 + (x >> 1)];
        const index = x & 1 ? byte >> 4 : byte & 0x0f;
        const color = data.readUInt16LE(0x200 + index * 2);
        const at = (((tile >> 2) * 8 + y) * 32 + (tile & 3) * 8 + x) * 4;
        rgba[at] = expand(color & 0x1f);
        rgba[at + 1] = expand((color >> 5) & 0x1f);
        rgba[at + 2] = expand((color >> 10) & 0x1f);
        rgba[at + 3] = index ? 0xff : 0;
      }
    }
  }
  return encodePng(32, 32, rgba);
}

// Keyed by the ROM's path: the same game opened from the same place.
const pictureKey = (romPath) => crypto.createHash('sha1').update(romPath.toLowerCase()).digest('hex');
// A .zip is played through the ROM it unpacks to (hub:unpack-rom), so its
// last screen is filed under that one; this remembers which it was.
const unpackedFrom = (zipPath) => userFile('covers', `${pictureKey(zipPath)}.link`);

// Where a downloaded or unpacked ROM lands, and its save next to it. The
// same game opened again finds its own file, untouched. A different dump
// under the same name gets a name of its own instead of replacing that
// file: the save beside it belongs to the first one, and pairing it with
// other bytes can break the game.
function keepRom(name, bytes) {
  const romPath = userFile('roms', path.basename(name));
  if (!fs.existsSync(romPath)) {
    fs.writeFileSync(romPath, bytes);
    return romPath;
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fs.readFileSync(romPath).equals(view)) return romPath;
  const renamed = romPath.replace(/(\.[^.]+)$/, ` (${zlib.crc32(view).toString(16)})$1`);
  fs.writeFileSync(renamed, view);
  return renamed;
}

function requireToken() {
  if (!token) throw new Error('No has iniciado sesión');
  return token;
}

// ---- Handlers ---------------------------------------------------------

// The installer an in-app update downloaded, left in the temp folder because
// it was still running when the old version quit. By the next start it has
// finished, so it can go. A hundred megabytes per update otherwise.
function removeUpdateInstallers() {
  const temp = app.getPath('temp');
  for (const name of fs.readdirSync(temp)) {
    if (!/^multiemu-.+-setup[.]exe$/.test(name)) continue;
    try {
      fs.unlinkSync(path.join(temp, name));
    } catch {
      // Still in use when --force-run starts the app before the installer
      // has exited. The next start gets it.
    }
  }
}

function register() {
  restoreToken();
  removeUpdateInstallers();

  ipcMain.handle('hub:files', (event, params) => shared.listFiles(params));

  // Cover art, fetched here and handed over as a data: URL rather than let
  // the page load it directly. A renderer on a file:// origin does not get
  // to pull remote images, so <img src="https://cdn..."> just breaks; the
  // main process has no such restriction. Cached for the session because
  // the same thumbnails come back with every search.
  const covers = new Map();
  async function coverDataUrl(url) {
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
  }
  ipcMain.handle('hub:cover', (event, url) => coverDataUrl(url));

  // A ROM file's picture as a data: URL, or null -- for the recents and ROM
  // folder lists, and a DS game's background. See "Pictures taken from the
  // games themselves" above: the DS icon (kept once drawn, since the menu
  // asks for up to forty at every start), or the last screen of a Game Boy
  // or GBA game, which is null until the game has been played once.
  ipcMain.handle('hub:rom-cover', async (event, romPath) => {
    let entry;
    try {
      entry = romEntry(romPath);
    } catch {
      return null; // gone, or unreadable
    }
    if (!entry) return null;

    if (entry.extension === 'nds') {
      const icon = userFile('covers', `${pictureKey(romPath)}-icon.png`);
      if (!fs.existsSync(icon)) {
        let png = null;
        try {
          png = await dsIcon(romPath, entry);
        } catch {
          return null;
        }
        if (!png) return null;
        fs.writeFileSync(icon, png);
      }
      return `data:image/png;base64,${fs.readFileSync(icon).toString('base64')}`;
    }

    const link = unpackedFrom(romPath);
    const played = entry.zipped && fs.existsSync(link) ? fs.readFileSync(link, 'utf8') : romPath;
    const screen = userFile('covers', `${pictureKey(played)}-screen.png`);
    if (!fs.existsSync(screen)) return null;
    return `data:image/png;base64,${fs.readFileSync(screen).toString('base64')}`;
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

    return keepRom(name, romBytes);
  });

  // A .zip opened by hand or from the ROM folder, the way Android's file
  // picker takes one: unpacked to the same place as the catalogue's
  // downloads, because the save is kept next to the ROM and needs somewhere
  // that stays put. Anything else is a ROM already and comes back as is.
  ipcMain.handle('hub:unpack-rom', (event, filePath) => {
    if (!/\.zip$/i.test(filePath)) return filePath;
    const unpacked = shared.extractFromZip(new Uint8Array(fs.readFileSync(filePath)), ROM_EXTENSIONS);
    if (!unpacked) {
      throw new Error(`"${path.basename(filePath)}" no contiene ninguna ROM que este emulador pueda abrir`);
    }
    const romPath = keepRom(unpacked.name, unpacked.bytes);
    fs.writeFileSync(unpackedFrom(filePath), romPath);
    return romPath;
  });

  // A newer release for THIS platform, or null.
  async function newerRelease() {
    const { releases } = await shared.listAppReleases({ limit: 20 });
    return releases.find((release) => release.versionCode > VERSION_CODE && shared.isWindowsRelease(release)) ?? null;
  }

  ipcMain.handle('hub:update-check', newerRelease);

  // Downloads the new installer and runs it over this install, so updating
  // never means a trip to the website.
  //
  // The release is looked up again rather than taken from the check: its
  // signed download URL expires after five minutes, and the notice may have
  // been on screen for hours.
  ipcMain.handle('hub:update-install', async (event) => {
    const release = await newerRelease();
    if (!release) throw new Error('No hay ninguna versión nueva');

    const response = await fetch(release.apkUrl);
    if (!response.ok) throw new Error(`No se pudo descargar la actualización (HTTP ${response.status})`);

    const chunks = [];
    let received = 0;
    let lastPercent = -1;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      received += chunk.length;
      // Once per percent rather than per chunk, which would be thousands of
      // messages for a hundred-megabyte file.
      const percent = Math.floor((received / release.apkSize) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        event.sender.send('hub:update-progress', percent);
      }
    }

    // The only integrity check the API allows: it publishes a size, not a
    // hash. What it catches is a connection that dropped halfway, which
    // would otherwise hand NSIS a truncated installer and a cryptic error.
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== release.apkSize) {
      throw new Error('La descarga llegó incompleta. Inténtalo de nuevo.');
    }
    const installer = path.join(app.getPath('temp'), `multiemu-${release.version}-setup.exe`);
    fs.writeFileSync(installer, bytes);

    // electron-builder's own NSIS switches, the ones electron-updater passes:
    // /S skips the wizard, --updated installs over the existing directory,
    // --force-run starts the app again once it is done. Quitting straight
    // away lets the installer replace files this process has open; the game
    // save is flushed on the way out like any other close.
    spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  });

  // The fallback when installing from inside the app fails: the download
  // page, not the file, because the file's signed URL would have expired.
  ipcMain.handle('hub:open-download', () => shell.openExternal(DOWNLOAD_PAGE));

  ipcMain.handle('hub:notify-update', (event, version) => {
    if (!Notification.isSupported()) return false;
    const notification = new Notification({
      title: 'multiemu ' + version + ' disponible',
      body: 'Haz clic para actualizar.',
    });
    // Brings the window forward, where the update bar is already showing.
    notification.on('click', () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      win.show();
      win.focus();
    });
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

  // Slot 99 is the in-game battery save; 0-3 are whole-machine states.
  // Android reserves exactly this numbering (GAME_SAVE_CLOUD_SLOT), and
  // uploading a battery save to slot 0 -- which this used to do -- would
  // land on top of a save state made on the phone.
  //
  // bytes, when given, go up instead of savePath's contents: a state taken
  // from the running game, which is what Android's slot "Subir" sends.
  ipcMain.handle('hub:save-upload', async (event, { romPath, savePath, bytes: given, slot, filename }) => {
    if (!given && !fs.existsSync(savePath)) {
      throw new Error('Este juego todavía no ha guardado nada');
    }
    const bytes = given || new Uint8Array(fs.readFileSync(savePath));
    await shared.uploadCloudSave(requireToken(), gameKey(romPath), slot, bytes, filename);
    return zlib.crc32(bytes);
  });

  // For the check Android makes when a game opens (checkGameSaveConflict in
  // App.tsx): the CRC of the local battery save and of the cloud's, to tell
  // whether they differ before asking which one to keep. The cloud's has to
  // be downloaded for that -- the API lists no checksum -- but it is a few
  // kilobytes. Null for a side that has nothing.
  ipcMain.handle('hub:save-status', async (event, { romPath, savePath, slot }) => {
    const key = gameKey(romPath);
    const remote = (await shared.listCloudSaves(requireToken())).find(
      (save) => save.gameKey === key && save.slot === slot,
    );
    return {
      localCrc: fs.existsSync(savePath) ? zlib.crc32(fs.readFileSync(savePath)) : null,
      remote: remote && {
        id: remote.id,
        updatedAt: remote.updatedAt,
        crc: zlib.crc32(await shared.downloadCloudSave(token, remote.id)),
      },
    };
  });

  // One tick of Android's automatic upload (autoSyncGameSave): the battery
  // save goes up only if it changed since the last sync. Returns the CRC the
  // cloud now holds, for the next tick to compare against.
  ipcMain.handle('hub:save-sync', async (event, { romPath, savePath, slot, filename, lastCrc }) => {
    if (!fs.existsSync(savePath)) return lastCrc;
    const bytes = new Uint8Array(fs.readFileSync(savePath));
    const crc = zlib.crc32(bytes);
    if (crc === lastCrc) return lastCrc;
    await shared.uploadCloudSave(requireToken(), gameKey(romPath), slot, bytes, filename);
    return crc;
  });

  // Android's feedback screen (FeedbackScreen.tsx, docs/feedback-api.md):
  // signed in it goes under the account, otherwise as a guest with an
  // optional name. The screenshot goes up first and its key rides along.
  ipcMain.handle('hub:feedback', async (event, { body, guestName, image }) => {
    let imageKey;
    if (image) {
      const extension = path.extname(image).slice(1).toLowerCase();
      const type = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
      imageKey = await shared.uploadFeedbackScreenshot(
        new Uint8Array(fs.readFileSync(image)), path.basename(image), type, token || undefined,
      );
    }
    await shared.sendFeedback({
      body,
      deviceInfo: `Windows ${os.release()}`,
      // As releases are named: 1.9, not 1.9.0.
      appVersion: app.getVersion().replace(/\.0$/, ''),
      imageKey,
      guestName: token ? undefined : guestName || undefined,
    }, token || undefined);
  });

  // Android's Alert with named buttons, as the native dialog. Resolves to
  // the index of the button picked.
  ipcMain.handle('hub:ask', async (event, { title, message, buttons }) => {
    const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question',
      title: 'multiemu',
      message: title,
      detail: message,
      buttons,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    return response;
  });

  ipcMain.handle('hub:save-download', async (event, { id, savePath }) => {
    const bytes = await shared.downloadCloudSave(requireToken(), id);
    fs.writeFileSync(savePath, bytes);
    return savePath;
  });

  // Gone from the cloud for every device; the copy on this PC stays.
  ipcMain.handle('hub:save-delete', (event, id) => shared.deleteCloudSave(requireToken(), id));
}

module.exports = { register, VERSION_CODE };
