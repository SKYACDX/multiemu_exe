// Publica en RomHack Hub el instalador que compiló el CI de GitHub, nunca uno
// hecho a mano en esta PC:
//
//   node scripts/publish.js changelog.txt [vX.Y.Z] [--dry-run]
//
// El flujo de una versión es: commit con la versión en package.json y push a
// main; crear el tag vX.Y.Z y subirlo; el workflow build-windows compila y
// crea la Release vX.Y.Z con el .exe adjunto; entonces este script lo baja de
// esa Release, lo comprueba y lo sube al Hub. Sin tag, usa v<version de
// package.json>.
//
// La versión y el versionCode salen del package.json DEL TAG, que es lo que el
// CI compiló dentro del .exe (src/hub.js lo lee de ahí), y no del de esta
// carpeta: mantenerlos separados ya provocó una vez que la app se ofreciera a
// sí misma como actualización. --dry-run descarga y verifica todo, pero no toca
// el Hub.
//
// Publicar sigue el contrato de docs/app-listing-api.md: crear release ->
// presign -> PUT -> registrar el asset.
const crypto = require('crypto');
const fs = require('fs');

// Configurables solo para probar el script contra servidores locales.
const REPO = process.env.MULTIEMU_REPO || 'SKYACDX/multiemu_exe';
const GITHUB_API = process.env.MULTIEMU_GITHUB_API || 'https://api.github.com';
const GITHUB_RAW = process.env.MULTIEMU_GITHUB_RAW || 'https://raw.githubusercontent.com';
const HUB = process.env.MULTIEMU_HUB || 'https://www.emulatornds.online';
const TOKEN_FILE = process.env.MULTIEMU_TOKEN_FILE || 'D:/Projects/multiemu/.secrets/romhackhub-admin-token.txt';

const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

async function getJson(url, what) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'multiemu-publish' },
  });
  if (response.status === 404) throw new Error(`${what}: no existe (HTTP 404). ¿Terminó el CI de ese tag?`);
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
  return response.json();
}

// El único .exe de la Release. Más de uno, o ninguno, es un error: no se
// adivina cuál subir.
function findInstaller(release) {
  const installers = (release.assets || []).filter((asset) => /\.exe$/i.test(asset.name));
  if (installers.length !== 1) {
    throw new Error(`la Release ${release.tag_name} trae ${installers.length} archivos .exe y se esperaba exactamente 1`);
  }
  return installers[0];
}

// Baja el instalador y comprueba lo que GitHub dice de él: el tamaño siempre y,
// cuando la API da su huella, el SHA-256.
async function downloadInstaller(asset) {
  const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'multiemu-publish' } });
  if (!response.ok) throw new Error(`descarga de ${asset.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) {
    throw new Error(`${asset.name} llegó incompleto: ${bytes.length} bytes de ${asset.size}`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (asset.digest && asset.digest.startsWith('sha256:') && asset.digest !== `sha256:${sha256}`) {
    throw new Error(`${asset.name}: el SHA-256 descargado (${sha256}) no coincide con el de GitHub (${asset.digest})`);
  }
  if (bytes.subarray(0, 2).toString('latin1') !== 'MZ') {
    throw new Error(`${asset.name} no es un ejecutable de Windows (no empieza por MZ)`);
  }
  return { bytes, sha256 };
}

// Versión y versionCode que el CI compiló dentro de ese tag, comprobando que
// el tag y package.json cuentan lo mismo.
async function packageAtTag(tag) {
  const pkg = await getJson(`${GITHUB_RAW}/${REPO}/${tag}/package.json`, `package.json en ${tag}`);
  if (`v${pkg.version}` !== tag) throw new Error(`el tag ${tag} no coincide con package.json (v${pkg.version})`);
  if (!Number.isInteger(pkg.versionCode) || pkg.versionCode <= 0) {
    throw new Error(`package.json en ${tag} no trae un versionCode válido`);
  }
  return pkg;
}

async function hub(endpoint, options = {}) {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const response = await fetch(`${HUB}${endpoint}`, {
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

// log es inyectable para que las pruebas no tengan que silenciar console.log.
async function main(argv, log = console.log) {
  const dryRun = argv.includes('--dry-run');
  const [changelogFile, requestedTag] = argv.filter((argument) => !argument.startsWith('--'));
  if (!changelogFile) throw new Error('uso: node scripts/publish.js <fichero-de-changelog> [vX.Y.Z] [--dry-run]');

  const tag = requestedTag || `v${require('../package.json').version}`;
  if (!TAG_PATTERN.test(tag)) throw new Error(`"${tag}" no es un tag de versión (vX.Y.Z)`);

  const changelog = fs.readFileSync(changelogFile, 'utf8').trim();
  const release = await getJson(`${GITHUB_API}/repos/${REPO}/releases/tags/${tag}`, `la Release ${tag}`);
  const pkg = await packageAtTag(tag);
  const asset = findInstaller(release);
  if (!asset.name.includes(pkg.version)) {
    throw new Error(`el archivo ${asset.name} no lleva la versión ${pkg.version} en su nombre`);
  }

  // Versión corta para la web ("1.1"), no la de tres números de npm.
  const version = pkg.version.replace(/\.0$/, '');
  const filename = `multiemu-${version}.exe`;

  log(`${tag} (code ${pkg.versionCode}) <- ${asset.name}, ${(asset.size / 1048576).toFixed(1)} MB`);
  const { bytes, sha256 } = await downloadInstaller(asset);
  log(`descargado y verificado: SHA-256 ${sha256}`);
  if (dryRun) {
    log('--dry-run: no se toca el Hub.');
    return;
  }

  // Reutiliza la release si ya existe ese versionCode, para poder volver a
  // subir el binario sin crear un duplicado.
  const { releases } = await hub('/api/v1/app/releases?platform=windows&limit=50');
  let existing = releases.find((candidate) => candidate.versionCode === pkg.versionCode);

  if (existing) {
    log(`1/3 release ${pkg.versionCode} ya existia (id=${existing.id}), se reutiliza`);
  } else {
    // Sin minAndroidSdk: es lo que marca la release como de Windows.
    ({ release: existing } = await hub('/api/app/releases', {
      method: 'POST',
      body: JSON.stringify({ version, versionCode: pkg.versionCode, changelog, platform: 'windows' }),
    }));
    log(`1/3 release creada: id=${existing.id}`);
  }

  // El slot se sigue llamando apk:<id> aunque el fichero sea un .exe.
  const slot = `apk:${existing.id}`;
  const { uploadUrl, storedName } = await hub('/api/app/assets/presign', {
    method: 'POST',
    body: JSON.stringify({ slot, filename, fileSize: bytes.length, contentType: 'application/octet-stream' }),
  });
  log('2/3 presign ok');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`PUT -> HTTP ${put.status}`);

  await hub('/api/app/assets', {
    method: 'POST',
    body: JSON.stringify({ slot, storedName, originalName: filename }),
  });
  log(`3/3 binario subido y registrado (releaseId ${existing.id})`);
}

module.exports = { findInstaller, downloadInstaller, packageAtTag, main };

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('FALLO:', error.message);
    process.exit(1);
  });
}
