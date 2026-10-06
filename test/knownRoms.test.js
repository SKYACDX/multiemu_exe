// What the main process lets the page touch: only ROMs the user chose, and
// only their own .sav and .state files (src/knownRoms.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { knownRoms } = require('../src/knownRoms');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-roms-'));
try {
  const data = path.join(root, 'userdata');
  const games = path.join(root, 'juegos');
  const folder = path.join(root, 'carpeta');
  fs.mkdirSync(data);
  // What the user already had before the list existed is trusted once.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    recentRoms: [path.join(games, 'Reciente.gba')],
    romFolder: folder,
  }));
  const known = knownRoms(data);

  // known: from Recientes, from the folder, and anything remembered later
  known.assertKnownRom(path.join(games, 'Reciente.gba'));
  known.assertKnownRom(path.join(games, 'RECIENTE.GBA'));
  known.assertKnownRom(path.join(folder, 'Cualquiera.nds'));
  known.rememberRom(path.join(games, 'Elegida.gb'));
  known.assertKnownRom(path.join(games, 'Elegida.gb'));
  // and it survives a restart
  knownRoms(data).assertKnownRom(path.join(games, 'Elegida.gb'));

  // unknown: anything else, a subfolder of the folder, nothing at all
  for (const rom of [path.join(games, 'Otra.gba'), path.join(folder, 'sub', 'x.gba'), path.join(folder, 'notas.txt'), 'C:\\Windows\\win.ini', '', null, undefined]) {
    assert.throws(() => known.assertKnownRom(rom), /no se abrió desde multiemu/, String(rom));
  }

  // its own saves and states only
  const rom = path.join(games, 'Reciente.gba');
  for (const name of ['Reciente.sav', 'Reciente.state', 'Reciente.2.state', 'Reciente.auto.state', 'reciente.SAV']) {
    known.assertSaveOf(rom, path.join(games, name));
  }
  for (const save of [
    path.join(games, 'Otra.sav'), // another game's
    path.join(games, 'Reciente.exe'), // not a save
    path.join(games, 'Reciente.sav.lnk'),
    path.join(root, 'Reciente.sav'), // another folder
    path.join(games, '..', 'Reciente.sav'),
    path.join(games, 'RecienteX.sav'), // a name that only starts the same
  ]) {
    assert.throws(() => known.assertSaveOf(rom, save), /no es un guardado/, save);
  }
  assert.throws(() => known.assertSaveOf(path.join(games, 'Otra.gba'), path.join(games, 'Otra.sav')), /no se abrió/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('knownRoms: ok');
