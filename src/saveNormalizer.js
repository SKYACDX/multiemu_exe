// Turns a save file from another emulator into the bytes our cores read, or
// explains why it can't. The spec, shared with the Android app's Kotlin
// version (SaveNormalizer.kt in app/android/gbcore), is "Especificación del
// normalizador (v1)" in docs/save-import.md of the Android repo -- keep the
// two in step, test vectors included (test/saveNormalizer.test.js).
//
// Only wrappers are removed (a DeSmuME footer, a NO$GBA header, a RetroArch
// combined .srm, a GBA clock the DS doesn't use); the save data itself is
// never interpreted. Every size outside the valid set for the target is
// refused rather than guessed at.
//
// normalize(bytes, target) -> { bytes, note } or { error }, where target is
// 'gb', 'gba', 'nds' or 'nds-slot2' (the GBA cartridge in the DS).
const K = 1024;
const GB_SIZES = [512, 2 * K, 8 * K, 32 * K, 64 * K, 128 * K];
const GBA_SIZES = [512, 8 * K, 32 * K, 64 * K, 128 * K];
const NDS_SIZES = [512, 8 * K, 32 * K, ...Array.from({ length: 10 }, (_, i) => (64 * K) << i)];
const GBA_CLOCK = 16;
const VBA_COMBINED = 0x22000;
const DESMUME_FOOTER = 122;
const DESMUME_MAGIC = Buffer.from('|-DESMUME SAVE-|', 'ascii');
const NOCASH_MAGIC = Buffer.from('NocashGbaBackupMediaSavDataFile', 'ascii');
const NOCASH_DATA = 0x4c;

const NAMES = {
  gb: 'Game Boy',
  gba: 'Game Boy Advance',
  nds: 'Nintendo DS',
  'nds-slot2': 'Game Boy Advance (ranura del DS)',
};

function normalize(input, target) {
  let data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!data.length) return { error: 'Ese archivo está vacío.' };
  const badSize = { error: `Ese archivo no tiene el tamaño de un guardado de ${NAMES[target] || target} (${data.length} bytes).` };
  let note = null;
  switch (target) {
    case 'gb':
      if (![0, 44, 48].some((footer) => GB_SIZES.includes(data.length - footer))) return badSize;
      break;
    case 'gba':
      if (data.length === VBA_COMBINED) {
        const sram = data.subarray(0, 0x20000);
        data = sram.some((byte) => byte !== 0xff) ? sram : data.subarray(0x20000);
        note = 'Convertido desde RetroArch (VBA).';
      }
      if (![0, GBA_CLOCK].some((footer) => GBA_SIZES.includes(data.length - footer))) return badSize;
      break;
    case 'nds':
      if (data.length >= DESMUME_FOOTER && data.subarray(data.length - DESMUME_MAGIC.length).equals(DESMUME_MAGIC)) {
        data = data.subarray(0, data.length - DESMUME_FOOTER);
        note = 'Convertido desde DeSmuME/DraStic.';
      } else if (data.subarray(0, NOCASH_MAGIC.length).equals(NOCASH_MAGIC)) {
        if (data.length < NOCASH_DATA) return badSize;
        if (data.readUInt32LE(0x44) !== 0) {
          return { error: 'Es un guardado comprimido de NO$GBA. En NO$GBA, guárdalo sin compresión e inténtalo de nuevo.' };
        }
        data = data.subarray(NOCASH_DATA);
        note = 'Convertido desde NO$GBA.';
      }
      if (!NDS_SIZES.includes(data.length)) return badSize;
      break;
    case 'nds-slot2':
      if (data.length !== 128 * K + GBA_CLOCK && GBA_SIZES.includes(data.length - GBA_CLOCK)) {
        data = data.subarray(0, data.length - GBA_CLOCK);
        note = 'Se quitó el reloj del cartucho (el DS no lo usa).';
      }
      if (!GBA_SIZES.includes(data.length) && data.length !== 128 * K + GBA_CLOCK) return badSize;
      break;
    default:
      return { error: `Sistema desconocido: ${target}` };
  }
  if (data.every((byte) => byte === 0xff) || data.every((byte) => byte === 0)) {
    note = [note, 'Ojo: el guardado parece vacío.'].filter(Boolean).join(' ');
  }
  return { bytes: new Uint8Array(data), note };
}

module.exports = { normalize };
