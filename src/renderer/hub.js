// The RomHack Hub screens: the update banner, the game catalogue, and the
// account panel. All the network work happens in the main process (see
// src/hub.js) -- this file only draws what comes back.
//
// renderer.js owns the emulator itself and provides two hooks: playRom() to
// boot a path, and loadedRom() to say what is currently running.

const panels = {
  picker: document.getElementById('picker'),
  browser: document.getElementById('browser'),
  account: document.getElementById('account'),
};

function show(name) {
  for (const [key, element] of Object.entries(panels)) element.hidden = key !== name;
}

for (const back of document.querySelectorAll('.back')) {
  back.addEventListener('click', () => show('picker'));
}

// ---- Update banner ----------------------------------------------------

async function checkForUpdate() {
  let release;
  try {
    release = await hub.updateCheck();
  } catch {
    return; // offline, or the API is down: not worth telling anyone
  }
  if (!release) return;

  const banner = document.getElementById('update');
  banner.hidden = false;
  banner.replaceChildren(
    element('strong', `Hay una versión nueva: ${release.version}`),
    element('pre', release.changelog || ''),
  );
}

// ---- Catalogue --------------------------------------------------------

const results = document.getElementById('results');
const browserStatus = document.getElementById('browser-status');
const search = document.getElementById('search');
const platformSelect = document.getElementById('platform');

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadPlatforms() {
  try {
    const { platforms } = await hub.platforms();
    for (const platform of platforms) {
      const option = element('option', platform.name);
      option.value = platform.slug;
      platformSelect.append(option);
    }
  } catch {
    // The filter is a convenience; the list still works without it.
  }
}

let searchToken = 0;

async function loadFiles() {
  const token = ++searchToken;
  browserStatus.textContent = 'Buscando…';
  results.replaceChildren();

  let files;
  try {
    ({ files } = await hub.files({
      q: search.value || undefined,
      platform: platformSelect.value || undefined,
      limit: 50,
    }));
  } catch (error) {
    browserStatus.textContent = error.message;
    return;
  }
  // A slower earlier search must not overwrite a newer one's results.
  if (token !== searchToken) return;

  browserStatus.textContent = files.length ? '' : 'No hay nada que coincida.';
  results.replaceChildren(...files.map(fileRow));
}

function fileRow(file) {
  const row = document.createElement('li');

  const cover = document.createElement('img');
  cover.alt = '';
  // Routed through the main process rather than set straight to
  // file.coverImageUrl: this page has a file:// origin, which Chromium does
  // not let load remote images. `platform` is often null too -- the API
  // types both fields as required but the catalogue does not honour that.
  if (file.coverImageUrl) {
    hub.cover(file.coverImageUrl).then((dataUrl) => {
      if (dataUrl) cover.src = dataUrl;
    });
  }

  const title = element('div', undefined, 'title');
  title.append(
    element('strong', file.title),
    element('span', [file.platform?.name, megabytes(file.fileSize)].filter(Boolean).join(' · ')),
  );

  const play = element('button', 'Descargar y jugar');
  play.className = 'primary';
  play.addEventListener('click', async () => {
    play.disabled = true;
    play.textContent = 'Descargando…';
    try {
      playRom(await hub.download(file));
    } catch (error) {
      browserStatus.textContent = error.message;
      play.disabled = false;
      play.textContent = 'Descargar y jugar';
    }
  });

  row.append(cover, title, play);
  return row;
}

document.getElementById('browse').addEventListener('click', () => {
  show('browser');
  loadFiles();
});

// Re-search as the user types, but only once they stop.
let searchTimer = null;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadFiles, 300);
});
platformSelect.addEventListener('change', loadFiles);

// ---- Account ----------------------------------------------------------

const accountStatus = document.getElementById('account-status');
const loginForm = document.getElementById('login');
const totpForm = document.getElementById('totp');
const session = document.getElementById('session');
const cloudSaves = document.getElementById('cloud-saves');

let pendingToken = null;

function showSession(username) {
  loginForm.hidden = true;
  totpForm.hidden = true;
  session.hidden = false;
  document.getElementById('session-user').textContent = `Conectado como ${username}`;
  loadCloudSaves();
}

async function loadCloudSaves() {
  cloudSaves.replaceChildren();
  let saves;
  try {
    saves = await hub.saves();
  } catch (error) {
    accountStatus.textContent = error.message;
    return;
  }
  if (!saves.length) {
    accountStatus.textContent = 'No tienes guardados en la nube todavía.';
    return;
  }
  accountStatus.textContent = '';
  cloudSaves.replaceChildren(...saves.map(saveRow));
}

function saveRow(save) {
  const row = document.createElement('li');
  const title = element('div', undefined, 'title');
  title.append(
    element('strong', save.originalName),
    element('span', `${megabytes(save.fileSize)} · ${new Date(save.updatedAt).toLocaleString()}`),
  );

  const download = element('button', 'Traer');
  download.addEventListener('click', async () => {
    const rom = loadedRom();
    if (!rom) {
      accountStatus.textContent = 'Abre primero el juego al que pertenece este guardado.';
      return;
    }
    download.disabled = true;
    try {
      await hub.downloadSave({ id: save.id, savePath: rom.replace(/\.[^.]+$/, '.sav') });
      accountStatus.textContent = 'Guardado traído. Vuelve a abrir el juego para cargarlo.';
    } catch (error) {
      accountStatus.textContent = error.message;
    }
    download.disabled = false;
  });

  row.append(title, download);
  return row;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  accountStatus.textContent = 'Entrando…';
  try {
    const result = await hub.login({
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
    });
    if (result.requiresTotp) {
      pendingToken = result.pendingToken;
      loginForm.hidden = true;
      totpForm.hidden = false;
      accountStatus.textContent = 'Introduce el código de dos factores.';
      return;
    }
    accountStatus.textContent = '';
    showSession(result.username);
  } catch (error) {
    accountStatus.textContent = error.message;
  }
});

totpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { username } = await hub.totp({
      pendingToken,
      code: document.getElementById('totp-code').value,
    });
    accountStatus.textContent = '';
    showSession(username);
  } catch (error) {
    accountStatus.textContent = error.message;
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await hub.logout();
  session.hidden = true;
  loginForm.hidden = false;
  accountStatus.textContent = '';
});

document.getElementById('upload-save').addEventListener('click', async (event) => {
  const rom = loadedRom();
  if (!rom) {
    accountStatus.textContent = 'Abre un juego primero.';
    return;
  }
  event.target.disabled = true;
  try {
    // Keyed by the ROM's CRC32 rather than its filename, so the same
    // cartridge matches across devices -- src/hub.js does the hashing.
    await hub.uploadSave({ romPath: rom, savePath: rom.replace(/\.[^.]+$/, '.sav'), slot: 0 });
    accountStatus.textContent = 'Guardado subido.';
    loadCloudSaves();
  } catch (error) {
    accountStatus.textContent = error.message;
  }
  event.target.disabled = false;
});

document.getElementById('account-open').addEventListener('click', async () => {
  show('account');
  const account = await hub.account();
  if (account) showSession(account.username);
});

loadPlatforms();
checkForUpdate();
