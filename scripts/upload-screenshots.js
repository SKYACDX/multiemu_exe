// Sube capturas al listing de RomHack Hub, marcadas como de Windows:
//
//   node scripts/upload-screenshots.js capturas/*.png
//
// Mismo patron presign -> PUT -> registrar que publish.js, pero con
// slot "screenshot" y platform "windows" (ver docs/app-listing-api.md en el
// repo compartido, 2026-09-26). Sin ese platform la captura cae en la
// galeria de Android, que es un array aparte.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.emulatornds.online';
const TOKEN_FILE = 'D:/Projects/multiemu/.secrets/romhackhub-admin-token.txt';

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
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('uso: node scripts/upload-screenshots.js <png...>');

  for (const file of files) {
    const bytes = fs.readFileSync(file);
    const originalName = path.basename(file);

    const { uploadUrl, storedName } = await api('/api/app/assets/presign', {
      method: 'POST',
      body: JSON.stringify({
        slot: 'screenshot',
        filename: originalName,
        fileSize: bytes.length,
        contentType: 'image/png',
      }),
    });

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: bytes,
    });
    if (!put.ok) throw new Error(`PUT ${originalName} -> HTTP ${put.status}`);

    await api('/api/app/assets', {
      method: 'POST',
      body: JSON.stringify({
        slot: 'screenshot',
        storedName,
        originalName,
        platform: 'windows',
      }),
    });
    console.log(`subida ${originalName} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }
}

main().catch((error) => {
  console.error('FALLO:', error.message);
  process.exit(1);
});
