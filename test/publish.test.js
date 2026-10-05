// scripts/publish.js contra un GitHub y un Hub falsos en local: el camino bueno
// y cada una de las cosas que tienen que frenar una publicación. No toca la red
// real ni el Hub de verdad. Node a secas.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
const sha = crypto.createHash('sha256').update(exe).digest('hex');

let base;
let scenario;
const hubCalls = [];
let putBytes = 0;

function reset(overrides = {}) {
  scenario = { digest: `sha256:${sha}`, exes: 1, size: exe.length, body: exe, pkgVersion: '9.9.9', existing: [], ...overrides };
  hubCalls.length = 0;
  putBytes = 0;
}

function read(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (request, response) => {
  const url = request.url;
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  if (url === '/repos/test/repo/releases/tags/v9.9.9') {
    const asset = (name) => ({ name, size: scenario.size, digest: scenario.digest, browser_download_url: `${base}/download/${name}` });
    const assets = [asset('multiemu.Setup.9.9.9.exe'), { name: 'notas.txt', size: 1 }];
    if (scenario.exes === 2) assets.push(asset('otro.exe'));
    if (scenario.exes === 0) assets.length = 0;
    return send(200, { tag_name: 'v9.9.9', assets });
  }
  if (url.startsWith('/repos/test/repo/releases/tags/')) return send(404, { message: 'Not Found' });
  if (url === '/test/repo/v9.9.9/package.json') return send(200, { version: scenario.pkgVersion, versionCode: 77 });
  if (url.startsWith('/download/')) return send(200, scenario.body, 'application/octet-stream');

  // Hub
  if (url.startsWith('/api/v1/app/releases')) return send(200, { releases: scenario.existing });
  if (url === '/api/app/releases') {
    hubCalls.push(['release', JSON.parse((await read(request)).toString())]);
    return send(201, { release: { id: 'r1' } });
  }
  if (url === '/api/app/assets/presign') {
    hubCalls.push(['presign', JSON.parse((await read(request)).toString())]);
    return send(200, { uploadUrl: `${base}/put`, storedName: 'app-assets/apk:r1/x.exe' });
  }
  if (url === '/put') {
    putBytes = (await read(request)).length;
    return send(200, '');
  }
  if (url === '/api/app/assets') {
    hubCalls.push(['register', JSON.parse((await read(request)).toString())]);
    return send(200, { ok: true });
  }
  return send(404, { error: url });
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
  const tokenFile = path.join(dir, 'token.txt');
  const changelogFile = path.join(dir, 'changelog.txt');
  fs.writeFileSync(tokenFile, 'token-de-prueba\n');
  fs.writeFileSync(changelogFile, 'Lo nuevo.\n');

  process.env.MULTIEMU_REPO = 'test/repo';
  process.env.MULTIEMU_GITHUB_API = base;
  process.env.MULTIEMU_GITHUB_RAW = base;
  process.env.MULTIEMU_HUB = base;
  process.env.MULTIEMU_TOKEN_FILE = tokenFile;
  const { main: publish } = require('../scripts/publish.js');

  // main gets its own logger, so the test never silences console.log (which
  // would swallow the other tests' output when they run in the same process).
  const publishes = (...args) => publish([changelogFile, ...args], () => {});

  try {
    // --dry-run: baja y verifica, pero no toca el Hub
    reset();
    await publishes('v9.9.9', '--dry-run');
    assert.deepStrictEqual(hubCalls, [], 'dry-run no escribe en el Hub');

    // publicación completa
    reset();
    await publishes('v9.9.9');
    assert.deepStrictEqual(hubCalls.map(([name]) => name), ['release', 'presign', 'register']);
    const created = hubCalls[0][1];
    assert.deepStrictEqual(created, { version: '9.9.9', versionCode: 77, changelog: 'Lo nuevo.', platform: 'windows' });
    assert.ok(!('minAndroidSdk' in created), 'sin minAndroidSdk: es lo que la marca como de Windows');
    assert.deepStrictEqual(hubCalls[1][1], {
      slot: 'apk:r1', filename: 'multiemu-9.9.9.exe', fileSize: exe.length, contentType: 'application/octet-stream',
    });
    assert.strictEqual(putBytes, exe.length, 'sube exactamente los bytes del instalador del CI');
    assert.strictEqual(hubCalls[2][1].originalName, 'multiemu-9.9.9.exe');

    // un versionCode que ya existe se reutiliza
    reset({ existing: [{ id: 'viejo', versionCode: 77 }] });
    await publishes('v9.9.9');
    assert.deepStrictEqual(hubCalls.map(([name]) => name), ['presign', 'register'], 'no crea otra release');
    assert.strictEqual(hubCalls[0][1].slot, 'apk:viejo');

    // cada cosa que tiene que frenarla, sin llegar al Hub
    const stops = [
      [{ digest: 'sha256:' + '0'.repeat(64) }, /no coincide con el de GitHub/, 'SHA-256 distinto'],
      [{ exes: 2 }, /2 archivos .exe/, 'dos instaladores'],
      [{ exes: 0 }, /0 archivos .exe/, 'ningun instalador'],
      [{ size: exe.length + 10 }, /incompleto/, 'tamano distinto'],
      [{ body: Buffer.from('<html>no es un exe</html>'), size: 25, digest: undefined }, /no es un ejecutable/, 'no empieza por MZ'],
      [{ pkgVersion: '9.9.8' }, /no coincide con package.json/, 'tag distinto del package.json'],
    ];
    for (const [overrides, expected, label] of stops) {
      reset(overrides);
      await assert.rejects(publishes('v9.9.9'), expected, label);
      assert.deepStrictEqual(hubCalls, [], `${label}: no se toca el Hub`);
    }
    reset();
    await assert.rejects(publishes('v9.9.8'), /no existe/, 'release inexistente');
    await assert.rejects(publishes('9.9.9'), /no es un tag/, 'tag mal escrito');
    await assert.rejects(publish([], () => {}), /uso:/, 'sin changelog');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('publish: ok'),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
