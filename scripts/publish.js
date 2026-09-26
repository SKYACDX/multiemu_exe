// Publica el instalador en RomHack Hub siguiendo docs/app-listing-api.md:
// crear release -> presign -> PUT -> registrar el asset.
//
//   node scripts/publish.js changelog.txt
//
// La version y el versionCode salen de package.json, que es lo mismo que
// compila el propio .exe (ver src/hub.js). Mantenerlos separados ya provoco
// una vez que la app se ofreciera a si misma como actualizacion.
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

const BASE = 'https://www.emulatornds.online';
const TOKEN_FILE = 'D:/Projects/multiemu/.secrets/romhackhub-admin-token.txt';

// Version corta para la web ("1.1"), no la de tres numeros de npm.
const VERSION = pkg.version.replace(/\.0$/, '');
const SETUP = path.join(__dirname, '..', 'dist', `multiemu Setup ${pkg.version}.exe`);
const FILENAME = `multiemu-${VERSION}.exe`;

async function api(endpoint, options = {}) {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const response = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint} -> HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const changelogFile = process.argv[2];
  if (!changelogFile) throw new Error('uso: node scripts/publish.js <fichero-de-changelog>');

  const changelog = fs.readFileSync(changelogFile, 'utf8').trim();
  const bytes = fs.readFileSync(SETUP);
  console.log(`v${VERSION} (code ${pkg.versionCode}), ${(bytes.length / 1048576).toFixed(1)} MB`);

  // Reutiliza la release si ya existe ese versionCode, para poder volver a
  // subir el binario sin crear un duplicado.
  const { releases } = await api(`/api/v1/app/releases?platform=windows&limit=50`);
  let release = releases.find((candidate) => candidate.versionCode === pkg.versionCode);

  if (release) {
    console.log(`1/3 release ${pkg.versionCode} ya existia (id=${release.id}), se reutiliza`);
  } else {
    // Sin minAndroidSdk: es lo que marca la release como de Windows.
    ({ release } = await api('/api/app/releases', {
      method: 'POST',
      body: JSON.stringify({
        version: VERSION,
        versionCode: pkg.versionCode,
        changelog,
        platform: 'windows',
      }),
    }));
    console.log(`1/3 release creada: id=${release.id}`);
  }

  // El slot se sigue llamando apk:<id> aunque el fichero sea un .exe.
  const slot = `apk:${release.id}`;
  const { uploadUrl, storedName } = await api('/api/app/assets/presign', {
    method: 'POST',
    body: JSON.stringify({
      slot,
      filename: FILENAME,
      fileSize: bytes.length,
      contentType: 'application/octet-stream',
    }),
  });
  console.log('2/3 presign ok');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`PUT -> HTTP ${put.status}`);

  await api('/api/app/assets', {
    method: 'POST',
    body: JSON.stringify({ slot, storedName, originalName: FILENAME }),
  });
  console.log(`3/3 binario subido y registrado (releaseId ${release.id})`);
}

main().catch((error) => {
  console.error('FALLO:', error.message);
  process.exit(1);
});
