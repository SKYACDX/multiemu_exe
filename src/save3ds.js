// Cloud saves for the 3DS.
//
// A Game Boy, GBA or DS game saves into one file. Azahar's libretro core has
// no save RAM at all (retro_get_memory_data returns NULL): a 3DS game writes
// ordinary files into the emulated console's SD card, under
//
//   <userData>/3ds/Azahar/sdmc/Nintendo 3DS/<id0>/<id1>/title/<high>/<low>/data
//
// so the save that goes to the cloud is that folder, packed as a zip.
//
// The pieces below are a contract with the Android app, which does the same:
//
//   key       "3ds:" + the game's 16-digit program ID, lowercase hex, read from
//             the NCCH header. Not a CRC of the ROM: a 3DS dump is 1-4GB and
//             differs between .3ds/.cci/.cxi and encrypted/decrypted copies of
//             the same game, while the program ID never does.
//   slots     99 is the game's save (this zip), as for the other consoles'
//             battery save, and works on both platforms. Save STATES do not:
//             Azahar writes them with boost binary_archive, whose `long` is 4
//             bytes on MSVC and 8 on arm64, so a state from one never loads on
//             the other. Each platform keeps its own under the same key and
//             name "slotN.sav": Windows 0-3, Android 10-13 (10+N, 13 the
//             automatic one). Each lists and downloads only its own.
//   zip       the contents of the `data` folder only, paths relative to it
//             ("00000001.metadata", "00000001/00000001.sav"), forward slashes,
//             no id0/id1 and no "title/..." prefix, so it restores into
//             whatever SD the other device has. An empty folder is a
//             zero-length entry with a trailing "/".
//   extdata   not included. Only `data`.
//   compare   fingerprint(), not the zip's own CRC: zip bytes depend on the
//             tool, the compression level and the clock, the content does not.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { unzipSync, zipSync } = require('fflate');

const ID_PATTERN = /^[0-9a-f]{32}$/i;
const ZERO_ID = '0'.repeat(32);
// A save is a few hundred KB; the cloud refuses more than 20MB zipped. This
// only stops a hostile zip from being inflated into all of memory.
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const hex8 = (n) => n.toString(16).padStart(8, '0');

// The game's program ID as 16 lowercase hex digits, or null if the file is not
// a 3DS game this can read. readAt(offset, length) gives bytes of the ROM, so
// the same code serves a plain file, a zip entry and a test fixture.
//
// The NCCH header is never encrypted, even in an encrypted dump: the program
// ID sits at 0x118 of it. A .3ds/.cci is an NCSD whose first partition (the
// game) starts at the offset in its header; a .cxi is that NCCH on its own.
async function programId(readAt) {
  const outer = await readAt(0, 0x200);
  if (outer.length < 0x200) return null;
  const magic = outer.toString('ascii', 0x100, 0x104);
  const ncch = magic === 'NCSD' ? outer.readUInt32LE(0x120) * 0x200 : magic === 'NCCH' ? 0 : -1;
  if (ncch < 0) return null;
  const header = ncch === 0 ? outer : await readAt(ncch, 0x200);
  if (header.length < 0x120 || header.toString('ascii', 0x100, 0x104) !== 'NCCH') return null;
  return hex8(header.readUInt32LE(0x11c)) + hex8(header.readUInt32LE(0x118));
}

const gameKey = (id) => `3ds:${id}`;

// ponytail: Azahar names its SD folders after the console's ID, which here is
// always the all-zero pair, so there is one of each. With several, the first
// is taken; if that ever bites, read which one the core was started with.
function onlyId(dir) {
  try {
    const found = fs.readdirSync(dir).filter((name) => ID_PATTERN.test(name)).sort();
    if (found.length) return found[0];
  } catch {
    // No SD card yet: the game has never run on this PC.
  }
  return ZERO_ID;
}

function dataDir(userDataDir, id) {
  const sd = path.join(userDataDir, '3ds', 'Azahar', 'sdmc', 'Nintendo 3DS');
  const id0 = onlyId(sd);
  const id1 = onlyId(path.join(sd, id0));
  return path.join(sd, id0, id1, 'title', id.slice(0, 8), id.slice(8), 'data');
}

// ---- A folder as a { "relative/path": bytes } object --------------------------

function readTree(dir) {
  const tree = {};
  function walk(relative) {
    const entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true });
    if (!entries.length && relative) tree[`${relative}/`] = new Uint8Array(0);
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) tree[child] = new Uint8Array(fs.readFileSync(path.join(dir, child)));
    }
  }
  try {
    walk('');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return tree;
}

// A folder only appears in a tree when it is empty. Other zip tools list every
// folder, and the same save must come out the same either way.
function canonical(tree) {
  const names = Object.keys(tree).filter((name) => {
    if (!name.endsWith('/')) return true;
    return !Object.keys(tree).some((other) => other !== name && other.startsWith(name));
  });
  names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(names.map((name) => [name, tree[name]]));
}

// Whether the game has written anything. Azahar creates a 1KB
// `00000001.metadata` (the archive's format info) the moment a game first
// boots, so a folder holding nothing else is a game that has not saved yet --
// and must never be mistaken for progress worth uploading over the cloud's.
function hasSaveData(tree) {
  return Object.keys(tree).some((name) => !name.endsWith('/') && !name.endsWith('.metadata'));
}

// CRC32 over each entry, sorted by name, as: name, 0x00, size in decimal,
// 0x00, bytes. Android computes the same thing.
function fingerprint(tree) {
  const sorted = canonical(tree);
  let crc = 0;
  for (const [name, data] of Object.entries(sorted)) {
    crc = zlib.crc32(Buffer.from(`${name}\0${data.length}\0`), crc);
    // Skipped when empty, which changes nothing for a CRC: zlib.crc32 returns
    // 0 instead of the running value for the zero-length view fflate hands
    // back for a folder.
    if (data.length) crc = zlib.crc32(data, crc);
  }
  return crc;
}

function pack(tree) {
  // Same bytes for the same save on any machine: sorted, one compression
  // level, one fixed date (local-time fields, so the zone does not matter).
  return zipSync(canonical(tree), { level: 6, mtime: new Date(1980, 0, 1) });
}

function unpack(bytes) {
  let total = 0;
  const tree = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (total > MAX_UNPACKED_BYTES) throw new Error('El guardado de la nube es demasiado grande');
      return true;
    },
  });
  const safe = {};
  for (const [stored, data] of Object.entries(tree)) {
    const name = stored.replace(/\\/g, '/');
    if (/^([a-zA-Z]:|\/)/.test(name) || name.split('/').includes('..')) {
      throw new Error('El guardado de la nube trae una ruta no permitida');
    }
    safe[name] = data;
  }
  return safe;
}

// Replaces dir with the tree. Written beside it first and swapped in with a
// rename, so a failure halfway leaves the old save where it was.
function writeTree(dir, tree) {
  const staging = `${dir}.incoming`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, data] of Object.entries(tree)) {
    const target = path.join(staging, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
  const replaced = `${dir}.replaced`;
  fs.rmSync(replaced, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, replaced);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(staging, dir);
  fs.rmSync(replaced, { recursive: true, force: true });
}

// The newest change anywhere under dir, in ms since the epoch; 0 if there is
// no such folder. The core writes straight through to these files while the
// game runs, so one touched a moment ago may be half written.
function newestMtimeMs(dir) {
  let newest = 0;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
      if (entry.isDirectory()) walk(full);
    }
  }
  try {
    walk(dir);
    newest = Math.max(newest, fs.statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
  return newest;
}

module.exports = {
  fingerprint,
  gameKey,
  dataDir,
  hasSaveData,
  newestMtimeMs,
  pack,
  programId,
  readTree,
  unpack,
  writeTree,
};
