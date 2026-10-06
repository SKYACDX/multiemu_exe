// The save normalizer against the test vectors shared with the Android app
// (SaveNormalizerTest.kt): the same inputs must give the same outputs in both.
const assert = require('assert');
const { normalize } = require('../src/saveNormalizer');

const K = 1024;
const filled = (length, value = 0x5a) => new Uint8Array(length).fill(value);
const ok = (result, length, note = null) => {
  assert.ok(!result.error, result.error);
  assert.strictEqual(result.bytes.length, length);
  assert.strictEqual(result.note, note);
};

// gb: plain sizes and the MBC3 clock footers pass untouched
for (const length of [8 * K, 32 * K, 32 * K + 48, 8 * K + 44]) ok(normalize(filled(length), 'gb'), length);
assert.match(normalize(filled(10000), 'gb').error, /10000 bytes/);
// gb: an all-0xFF save passes, with a warning
ok(normalize(filled(8 * K, 0xff), 'gb'), 8 * K, 'Ojo: el guardado parece vacío.');

// gba
ok(normalize(filled(128 * K + 16), 'gba'), 128 * K + 16);
const sram = filled(0x22000, 0xff);
sram[5] = 1;
ok(normalize(sram, 'gba'), 0x20000, 'Convertido desde RetroArch (VBA).');
const eeprom = filled(0x22000, 0xff);
eeprom[0x20000] = 1;
const fromEeprom = normalize(eeprom, 'gba');
ok(fromEeprom, 0x2000, 'Convertido desde RetroArch (VBA).');
assert.strictEqual(fromEeprom.bytes[0], 1, 'the EEPROM half is the last 0x2000');
assert.ok(normalize(filled(100 * K), 'gba').error);

// nds: DeSmuME/DraStic footer
const dsv = new Uint8Array(512 * K + 122).fill(0x5a);
dsv.set(Buffer.from('|-DESMUME SAVE-|', 'ascii'), dsv.length - 16);
ok(normalize(dsv, 'nds'), 512 * K, 'Convertido desde DeSmuME/DraStic.');
ok(normalize(filled(8 * K * K), 'nds'), 8 * K * K);
// nds: NO$GBA, uncompressed and compressed
const nocash = new Uint8Array(0x4c + 64 * K).fill(0x5a);
nocash.set(Buffer.from('NocashGbaBackupMediaSavDataFile', 'ascii'), 0);
Buffer.from(nocash.buffer).writeUInt32LE(0, 0x44);
ok(normalize(nocash, 'nds'), 64 * K, 'Convertido desde NO$GBA.');
Buffer.from(nocash.buffer).writeUInt32LE(1, 0x44);
assert.match(normalize(nocash, 'nds').error, /comprimido/);

// nds-slot2: the GBA clock is dropped except in the one size melonDS takes with it
ok(normalize(filled(8 * K + 16), 'nds-slot2'), 8 * K, 'Se quitó el reloj del cartucho (el DS no lo usa).');
ok(normalize(filled(128 * K + 16), 'nds-slot2'), 128 * K + 16);

// empty
assert.strictEqual(normalize(new Uint8Array(0), 'gb').error, 'Ese archivo está vacío.');

console.log('saveNormalizer: ok');
