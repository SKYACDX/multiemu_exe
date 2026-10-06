// The 3DS cloud save, checked without a console: the program ID read from a
// header, where a game's folder is, and that a save survives being packed,
// unpacked and put back. Plain node -- nothing here needs the addons.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync } = require('fflate');
const save3ds = require('../src/save3ds');

const bytes = (...values) => new Uint8Array(values);

// A ROM as readAt sees it: just the header fields programId looks at.
function fixture(layout) {
  const rom = Buffer.alloc(0x600);
  const ncchAt = layout === 'cxi' ? 0 : 0x200;
  if (layout !== 'cxi') {
    rom.write('NCSD', 0x100, 'ascii');
    rom.writeUInt32LE(ncchAt / 0x200, 0x120); // first partition, in media units
  }
  rom.write('NCCH', ncchAt + 0x100, 'ascii');
  rom.writeUInt32LE(0x000ba900, ncchAt + 0x118); // program ID, low half...
  rom.writeUInt32LE(0x00040000, ncchAt + 0x11c); // ...and high half
  return (offset, length) => Promise.resolve(rom.subarray(offset, offset + length));
}

async function main() {
  // ---- which game
  assert.strictEqual(await save3ds.programId(fixture('ncsd')), '00040000000ba900');
  assert.strictEqual(await save3ds.programId(fixture('cxi')), '00040000000ba900');
  assert.strictEqual(save3ds.gameKey('00040000000ba900'), '3ds:00040000000ba900');
  assert.strictEqual(await save3ds.programId(() => Promise.resolve(Buffer.alloc(0x200))), null, 'not a 3DS file');
  assert.strictEqual(await save3ds.programId(() => Promise.resolve(Buffer.alloc(16))), null, 'too short');

  // ---- where its folder is
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'save3ds-'));
  try {
    const zeros = '0'.repeat(32);
    assert.strictEqual(
      save3ds.dataDir(root, '00040000000ba900'),
      path.join(root, '3ds', 'Azahar', 'sdmc', 'Nintendo 3DS', zeros, zeros, 'title', '00040000', '000ba900', 'data'),
      'no SD yet: the all-zero console ID',
    );
    const id = 'ab'.repeat(16);
    fs.mkdirSync(path.join(root, '3ds', 'Azahar', 'sdmc', 'Nintendo 3DS', id, id), { recursive: true });
    assert.ok(save3ds.dataDir(root, '00040000000ba900').includes(id), 'follows the ID the SD already has');

    // ---- a save through pack, unpack and back onto disk
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, '00000001'), { recursive: true });
    fs.mkdirSync(path.join(source, 'empty'));
    fs.writeFileSync(path.join(source, '00000001.metadata'), bytes(9, 9));
    fs.writeFileSync(path.join(source, '00000001', '00000001.sav'), bytes(1, 2, 3, 4));

    const tree = save3ds.readTree(source);
    assert.deepStrictEqual(
      Object.keys(tree).sort(),
      ['00000001.metadata', '00000001/00000001.sav', 'empty/'],
      'files by relative path, and a folder only when it is empty',
    );
    assert.ok(save3ds.hasSaveData(tree));

    const zipped = save3ds.pack(tree);
    assert.deepStrictEqual(Buffer.from(save3ds.pack(tree)), Buffer.from(zipped), 'same bytes every time');
    const restored = save3ds.unpack(zipped);
    assert.strictEqual(save3ds.fingerprint(restored), save3ds.fingerprint(tree));

    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'stale.sav'), bytes(7));
    save3ds.writeTree(target, restored);
    assert.deepStrictEqual(Object.keys(save3ds.readTree(target)).sort(), Object.keys(tree).sort(), 'old files are replaced, not merged');
    assert.strictEqual(save3ds.fingerprint(save3ds.readTree(target)), save3ds.fingerprint(tree));
    assert.ok(!fs.existsSync(`${target}.incoming`) && !fs.existsSync(`${target}.replaced`), 'no leftovers beside it');

    // ---- the fingerprint is the contract with Android: same input, same number
    assert.strictEqual(
      save3ds.fingerprint({ '00000001/00000001.sav': bytes(1, 2, 3, 4), 'empty/': bytes() }),
      FINGERPRINT_OF_REFERENCE,
      'Android must get this exact number for the same two entries',
    );
    // A zip tool that lists every folder is the same save.
    assert.strictEqual(
      save3ds.fingerprint({ '00000001/': bytes(), '00000001/00000001.sav': bytes(1, 2, 3, 4), 'empty/': bytes() }),
      FINGERPRINT_OF_REFERENCE,
    );
    assert.notStrictEqual(save3ds.fingerprint({ 'a.sav': bytes(1) }), save3ds.fingerprint({ 'b.sav': bytes(1) }), 'the name counts');
    assert.notStrictEqual(save3ds.fingerprint({ 'a.sav': bytes(1) }), save3ds.fingerprint({ 'a.sav': bytes(2) }), 'the bytes count');

    // ---- has the game saved anything?
    assert.ok(!save3ds.hasSaveData({}), 'nothing at all');
    assert.ok(!save3ds.hasSaveData({ '00000001.metadata': bytes(9) }), 'only what the core creates at boot');
    assert.ok(!save3ds.hasSaveData({ 'empty/': bytes() }));
    assert.ok(save3ds.hasSaveData({ '00000001.metadata': bytes(9), 'game.sav': bytes(1) }));

    // ---- a hostile zip never lands outside the folder
    for (const name of ['../escape.sav', 'a/../../escape.sav', '/abs.sav', 'C:\\abs.sav', '..\\escape.sav']) {
      assert.throws(() => save3ds.unpack(zipSync({ [name]: bytes(1) })), /ruta no permitida/, name);
    }

    // ---- a doctored zip is refused, not unpacked short (security review of 1f8f01a)
    // The central directory record of the only entry: sizes at +20/+24, CRC at +16.
    const directory = (zip) => zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const honest = Buffer.from(zipSync({ main: new Uint8Array(4096).fill(7) }, { level: 0 }));
    assert.strictEqual(Object.keys(save3ds.unpack(honest)).length, 1, 'an honest zip still unpacks');
    const smaller = Buffer.from(honest); // declares 1024 bytes where there are 4096
    for (const at of [22, directory(smaller) + 20, directory(smaller) + 24]) smaller.writeUInt32LE(1024, at);
    assert.throws(() => save3ds.unpack(smaller), /dañado o manipulado/, 'size forged smaller');
    const wrongCrc = Buffer.from(honest);
    wrongCrc.writeUInt32LE(0x12345678, directory(wrongCrc) + 16);
    assert.throws(() => save3ds.unpack(wrongCrc), /dañado o manipulado/, 'wrong CRC');
    // names Windows treats specially: devices, NTFS streams, trailing dots and spaces, reserved characters
    for (const name of ['00000001/CON', '00000001/aux.txt', '00000001/Com1.sav', 'nul', '00000001/main:ads',
      '00000001/main.', '00000001/main ', 'a/./b', 'a//b', 'x<y', 'x?y', `x${String.fromCharCode(1)}y`]) {
      assert.throws(() => save3ds.unpack(zipSync({ [name]: bytes(1) })), /ruta no permitida/, name);
    }
    for (const name of ['00000001/console.sav', '00000001/con1', 'auxiliar']) {
      assert.ok(save3ds.unpack(zipSync({ [name]: bytes(1) }))[name], `${name} is an ordinary name`);
    }
    // two entries that would land on one file
    assert.throws(() => save3ds.unpack(zipSync({ 'a/Main': bytes(1), 'a/main': bytes(2) })), /repetidos/);
    assert.throws(() => save3ds.unpack(zipSync({ 'a\\b': bytes(1), 'a/b': bytes(2) })), /repetidos/);
    // too many entries
    const many = {};
    for (let i = 0; i <= 4096; i++) many[`f${i}`] = bytes(1);
    assert.throws(() => save3ds.unpack(zipSync(many)), /demasiados archivos/);
    // writeTree holds on its own, whatever unpack let through
    assert.throws(() => save3ds.writeTree(path.join(root, 'escape-test'), { '../fuera.sav': bytes(1) }), /ruta no permitida/);
    assert.ok(!fs.existsSync(path.join(root, 'fuera.sav')));

    // ---- a save brought from another emulator (importTree)
    const meta = bytes(7, 7);
    const mine = { '00000001.metadata': bytes(1, 1) }; // what this console made on first boot
    const keys = (result) => Object.keys(result.tree).sort();

    // Citra/Azahar: their data folder, under whatever prefix the zip has
    for (const prefix of ['', 'data/', '00040000/00055e00/data/']) {
      const result = save3ds.importTree({ [`${prefix}00000001.metadata`]: meta, [`${prefix}00000001/main`]: bytes(5) }, mine);
      assert.deepStrictEqual(keys(result), ['00000001.metadata', '00000001/main'], prefix);
      assert.deepStrictEqual(result.tree['00000001.metadata'], meta, 'its own metadata wins');
      assert.deepStrictEqual(result.warnings, []);
    }
    // Checkpoint: the archive's own files, loose or in a dated folder
    for (const folder of ['', '2026-10-05_12-00-00/']) {
      const result = save3ds.importTree({ [`${folder}main`]: bytes(5), [`${folder}sub/x`]: bytes(6) }, mine);
      assert.deepStrictEqual(keys(result), ['00000001.metadata', '00000001/main', '00000001/sub/x'], folder);
      assert.deepStrictEqual(result.tree['00000001.metadata'], mine['00000001.metadata'], 'keeps this console\'s metadata');
    }
    // extdata dropped with a warning; macOS and Windows litter ignored
    const extra = save3ds.importTree(
      { 'data/00000001/main': bytes(5), 'extdata/00000000/x': bytes(1), '__MACOSX/data/._main': bytes(1), 'Thumbs.db': bytes(1) },
      mine,
    );
    assert.deepStrictEqual(keys(extra), ['00000001.metadata', '00000001/main']);
    assert.strictEqual(extra.warnings.length, 1);
    // nothing to import, or nowhere to put it
    assert.throws(() => save3ds.importTree({ 'data/00000001.metadata': meta }, mine), /ninguna partida/);
    assert.throws(() => save3ds.importTree({}, mine), /ninguna partida/);
    assert.throws(() => save3ds.importTree({ main: bytes(5) }, {}), /Abre el juego una vez/);

    // ---- when a file last changed
    assert.strictEqual(save3ds.newestMtimeMs(path.join(root, 'nowhere')), 0);
    assert.ok(Date.now() - save3ds.newestMtimeMs(source) < 60_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Fixed on 2026-10-05 from the format in src/save3ds.js; change it only
// together with the Android app.
const FINGERPRINT_OF_REFERENCE = 2018605636;

main().then(
  () => console.log('save3ds: ok'),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
