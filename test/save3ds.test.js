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
