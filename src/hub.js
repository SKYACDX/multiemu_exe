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

const COVER_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// The start of a ROM, enough for readRomTitle, and which system it is for.
// Out of a .zip too, without unpacking it: a DS image in there runs to
// 512MB and only the first 0x200 bytes matter. Walks the zip's local file
// headers to the first ROM, then inflates just the first stretch of it --
// Z_SYNC_FLUSH makes zlib hand back what a cut-off stream decodes to
// instead of failing. Null if there is no ROM to be found that way.
function romHeader(romPath) {
  const extension = path.extname(romPath).slice(1).toLowerCase();
  const file = fs.openSync(romPath, 'r');
  try {
    if (extension !== 'zip') {
      const header = Buffer.alloc(0x200);
      fs.readSync(file, header, 0, header.length, 0);
      return { extension, header };
    }
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
        const chunk = Buffer.alloc(64 * 1024);
        const read = fs.readSync(file, chunk, 0, chunk.length, dataStart);
        const stored = local.readUInt16LE(8) === 0;
        const header = stored
          ? chunk.subarray(0, read)
          : zlib.inflateRawSync(chunk.subarray(0, read), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        return { extension: inner, header: header.subarray(0, 0x200) };
      }
      // Bit 3: the size comes after the data, so the next entry can't be found.
      if (local.readUInt16LE(6) & 8) return null;
      offset = dataStart + local.readUInt32LE(18);
    }
    return null;
  } finally {
    fs.closeSync(file);
  }
}

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

  // The cover of a ROM file, as a data: URL, or null -- for the background
  // behind the game, and the recents and ROM folder lists. Android's
  // findCoverArt: the title in the ROM's own header, searched in the
  // catalogue. Kept on disk once found, since the menu asks for up to forty
  // at every start; a ROM with none is asked about again after a week, in
  // case the catalogue has one by then.
  ipcMain.handle('hub:rom-cover', async (event, romPath) => {
    const key = crypto.createHash('sha1').update(romPath.toLowerCase()).digest('hex');
    const found = userFile('covers', `${key}.txt`);
    const missing = userFile('covers', `${key}.none`);
    if (fs.existsSync(found)) return fs.readFileSync(found, 'utf8');
    if (fs.existsSync(missing) && Date.now() - fs.statSync(missing).mtimeMs < COVER_RETRY_MS) return null;

    // findCoverArt's own search, spelled out: it swallows a failed request,
    // and offline must not be remembered as "has no cover".
    let url = null;
    try {
      const rom = romHeader(romPath);
      const title = rom && shared.readRomTitle(new Uint8Array(rom.header), rom.extension);
      if (title) {
        const platform = SYSTEM_BY_EXTENSION[rom.extension] || 'gb';
        const { files } = await shared.listFiles({ platform, q: title, limit: 5 });
        url = files.find((file) => file.coverImageUrl)?.coverImageUrl ?? null;
      }
    } catch {
      return null; // offline, or unreadable: tried again next time
    }
    if (!url) {
      fs.writeFileSync(missing, '');
      return null;
    }
    const dataUrl = await coverDataUrl(url);
    if (dataUrl) fs.writeFileSync(found, dataUrl);
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
    return keepRom(unpacked.name, unpacked.bytes);
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
}

module.exports = { register, VERSION_CODE };
