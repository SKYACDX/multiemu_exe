// The RomHack Hub screens: the update banner, the game catalogue, and the
// account panel. All the network work happens in the main process (see
// src/hub.js) -- this file only draws what comes back.
//
// renderer.js owns the emulator itself and provides two hooks: playRom() to
// boot a path, and loadedRom() to say what is currently running.

// Found rather than listed, so adding a panel to the page is enough.
function show(name) {
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== name;
}

// Back goes wherever the user came from: the pause menu when a game is
// waiting behind these panels, the main menu otherwise.
for (const back of document.querySelectorAll('.back')) {
  back.addEventListener('click', () => show(loadedRom() ? 'pause' : 'picker'));
}

// ---- Update notice ----------------------------------------------------
//
// Checked at startup and then every few hours, so a session that stays open
// for a day still finds out. The bar sits at the top of the window, over
// whatever is on screen, so it is visible mid-game and not only on the main
// menu -- the point is that nobody has to go looking.

// Long enough that it is nearly free (one small request), short enough that
// someone who leaves the app open all day hears about a release the same
// day. A session shorter than this is covered by the check at startup.
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;

const updateBar = document.getElementById('update');
let pendingUpdate = null;

async function checkForUpdate() {
  let release;
  try {
    release = await hub.updateCheck();
  } catch {
    return; // offline, or the API is down: not worth telling anyone
  }
  if (!release) return;

  // Already showing this one, so don't notify again on the next round.
  if (pendingUpdate && pendingUpdate.versionCode === release.versionCode) return;

  // Hidden for good once dismissed, until a newer one comes along.
  if (settings.read().dismissedUpdate >= release.versionCode) return;

  pendingUpdate = release;
  document.getElementById('update-title').textContent =
    `multiemu ${release.version} ya está disponible`;
  document.getElementById('update-changelog').textContent = release.changelog || '';
  updateBar.hidden = false;

  // Also as a real desktop notification, so it lands even with the window
  // behind something else.
  hub.notifyUpdate(release.version);
}

// Registered once, not per check: doing it inside checkForUpdate would stack
// a new listener every couple of hours.
document.getElementById('update-dismiss').addEventListener('click', () => {
  updateBar.hidden = true;
  if (pendingUpdate) {
    settings.write({ ...settings.read(), dismissedUpdate: pendingUpdate.versionCode });
  }
});

// What ipcRenderer.invoke puts in front of every error thrown in the main
// process. Only the part after it means anything to the user.
function ipcErrorMessage(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const updateButton = document.getElementById('update-download');

hub.onUpdateProgress((percent) => {
  updateButton.textContent = percent < 100 ? `Descargando… ${percent}%` : 'Instalando…';
});

updateButton.addEventListener('click', async () => {
  // After a failed attempt the button becomes a way out: the website still
  // works when installing from here doesn't.
  if (updateButton.dataset.fallback) {
    hub.openDownload();
    return;
  }
  updateButton.disabled = true;
  updateButton.textContent = 'Descargando…';
  try {
    // Never returns on success: the app closes and the installer reopens it.
    await hub.installUpdate();
  } catch (error) {
    document.getElementById('update-changelog').textContent = ipcErrorMessage(error);
    updateButton.textContent = 'Abrir la página de descarga';
    updateButton.dataset.fallback = '1';
    updateButton.disabled = false;
  }
});

setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

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

  // With a game open, only its own saves are worth showing -- the rest
  // belong to cartridges that aren't loaded and couldn't be restored
  // anyway. The key is the ROM's CRC32, computed in the main process.
  const rom = loadedRom();
  let onlyThisGame = false;
  if (rom) {
    const key = await hub.gameKey(rom);
    const mine = saves.filter((save) => save.gameKey === key);
    onlyThisGame = true;
    saves = mine;
  }

  if (!saves.length) {
    accountStatus.textContent = onlyThisGame
      ? 'Este juego no tiene guardados en la nube todavía.'
      : 'No tienes guardados en la nube todavía.';
    return;
  }
  accountStatus.textContent = onlyThisGame ? 'Guardados de este juego.' : '';
  cloudSaves.replaceChildren(...saves.map(saveRow));
}

// Slot -1 is the in-game battery save; 0-3 are whole-machine states, and
// Android's 3 is its automatic one. Naming them matters now that both kinds
// share one list: bringing a state down and writing it over the battery
// save would corrupt the cartridge.
function slotLabel(slot) {
  if (slot === GAME_SAVE_SLOT) return 'Partida guardada';
  if (slot === 3) return 'Estado automático';
  return `Estado ${slot + 1}`;
}

function saveRow(save) {
  const row = document.createElement('li');
  const title = element('div', undefined, 'title');
  title.append(
    element('strong', slotLabel(save.slot)),
    element('span', `${megabytes(save.fileSize)} · ${new Date(save.updatedAt).toLocaleString()}`),
  );

  const download = element('button', 'Traer');
  download.addEventListener('click', async () => {
    const rom = loadedRom();
    if (!rom) {
      toast('Abre primero el juego al que pertenece este guardado.');
      return;
    }
    download.disabled = true;

    // The running core has to let go of the file before it can be replaced.
    // mGBA keeps the save open and writes through it for the core's whole
    // lifetime, so replacing it underneath a live game fails outright -- and
    // would be pointless anyway, since the core would write its own copy back
    // over it moments later.
    emu.close();
    try {
      // A battery save and a save state are different files locally, and
      // putting one where the other belongs breaks the game.
      const extension = save.slot === GAME_SAVE_SLOT ? '.sav' : '.state';
      await hub.downloadSave({ id: save.id, savePath: rom.replace(/\.[^.]+$/, extension) });
      toast('Guardado traído de la nube');
    } catch (error) {
      // Not accountStatus: playRom below hides the account panel
      // straight away, so a message left there is never seen.
      toast(ipcErrorMessage(error));
    }
    // Reloaded either way: the game was torn down above, so leaving it down
    // on a failed download would strand the user on a dead session.
    playRom(rom);
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

// The slot the Android app reserves for the in-game battery save. Its save
// states live in 0-3, so uploading a battery save to slot 0 would land on
// top of one of those.
//
// 99 and not -1: it started as -1 and moved when the server turned out to
// reject negative slots ("Fix cloud save slot validation" in the shared
// repo). Reading the commit that introduced the constant rather than the
// one that last changed it is how this got picked wrong the first time.
const GAME_SAVE_SLOT = 99;

// The desktop app keeps a single save state per game rather than numbered
// slots, so it uploads as slot 0 and can bring any of them down.
const DESKTOP_STATE_SLOT = 0;

async function upload(button, { suffix, slot, filename, done }) {
  const rom = loadedRom();
  if (!rom) {
    accountStatus.textContent = 'Abre un juego primero.';
    return;
  }
  button.disabled = true;
  try {
    // Keyed by "<system>:<crc32>", the same identity the Android app uses,
    // so one cartridge matches across devices -- src/hub.js builds it.
    await hub.uploadSave({
      romPath: rom,
      savePath: rom.replace(/\.[^.]+$/, suffix),
      slot,
      filename,
    });
    accountStatus.textContent = done;
    loadCloudSaves();
  } catch (error) {
    accountStatus.textContent = error.message;
  }
  button.disabled = false;
}

document.getElementById('upload-save').addEventListener('click', (event) =>
  upload(event.target, {
    suffix: '.sav',
    slot: GAME_SAVE_SLOT,
    filename: 'game.sav',
    done: 'Partida subida.',
  }),
);

document.getElementById('upload-state').addEventListener('click', (event) =>
  upload(event.target, {
    suffix: '.state',
    slot: DESKTOP_STATE_SLOT,
    filename: `slot${DESKTOP_STATE_SLOT}.sav`,
    done: 'Estado subido.',
  }),
);

document.getElementById('account-open').addEventListener('click', async () => {
  show('account');
  const account = await hub.account();
  if (account) showSession(account.username);
});

loadPlatforms();
checkForUpdate();
