// ROMs the user chose, for the main process to check what the page names.
//
// The page names ROMs and their save files to the main process, and the page
// is where an injected script would run (the catalogue and the account panel
// draw what the server sends). So whatever there reads or writes a save next
// to a ROM does it only for a ROM the user chose through the main process --
// a dialog, a download or unpack, the command line, or the ROM folder they
// picked -- and only for that ROM's own .sav and .state files (security
// review of 320744c). The list lives in known-roms.json, which only the main
// process writes. The first time, it starts from the Recientes and the
// folder the user already had, so nothing they were playing stops working.
const fs = require('fs');
const path = require('path');

const KNOWN_LIMIT = 1000;
const normalPath = (file) => path.resolve(file).toLowerCase();

function knownRoms(userDataDir) {
  const file = path.join(userDataDir, 'known-roms.json');
  let known = null;

  function load() {
    if (known) return known;
    try {
      known = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      known = { roms: [], folders: [] };
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
        known.roms = (settings.recentRoms || []).map(normalPath);
        if (settings.romFolder) known.folders = [normalPath(settings.romFolder)];
      } catch {
        // A first start: nothing chosen yet.
      }
      save();
    }
    return known;
  }

  function save() {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(known));
  }

  function remember(kind, chosen) {
    if (!chosen) return;
    const list = load()[kind];
    const entry = normalPath(chosen);
    if (list.includes(entry)) return;
    list.push(entry);
    list.splice(0, Math.max(0, list.length - KNOWN_LIMIT));
    save();
  }

  function assertKnownRom(romPath) {
    const { roms, folders } = load();
    if (typeof romPath === 'string' && romPath &&
        (roms.includes(normalPath(romPath)) || folders.includes(normalPath(path.dirname(romPath))))) {
      return;
    }
    throw new Error('Esa ROM no se abrió desde multiemu');
  }

  // A file next to a known ROM, named after it, that is a save or a state:
  // "<rom>.sav", "<rom>.state", "<rom>.2.state", "<rom>.auto.state".
  function assertSaveOf(romPath, savePath) {
    assertKnownRom(romPath);
    const base = path.basename(romPath).replace(/\.[^.]+$/, '').toLowerCase();
    const name = path.basename(String(savePath)).toLowerCase();
    if (typeof savePath !== 'string' || normalPath(path.dirname(savePath)) !== normalPath(path.dirname(romPath)) ||
        !name.startsWith(`${base}.`) || !/\.(sav|state)$/.test(name)) {
      throw new Error('Ese no es un guardado de la ROM abierta');
    }
  }

  return {
    rememberRom: (rom) => remember('roms', rom),
    rememberFolder: (folder) => remember('folders', folder),
    assertKnownRom,
    assertSaveOf,
  };
}

module.exports = { knownRoms };
