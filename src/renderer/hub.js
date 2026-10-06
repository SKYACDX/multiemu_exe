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

// "2 GB", "16 MB", "65 KB": the largest unit with a whole number in front,
// with a decimal comma like the rest of the app.
const sizeNumber = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });
function fileSizeText(bytes) {
  for (const [unit, size] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]) {
    if (bytes >= size) return `${sizeNumber.format(bytes / size)} ${unit}`;
  }
  return `${bytes} B`;
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
    browserStatus.textContent = ipcErrorMessage(error);
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
    element('span', [file.platform?.name, fileSizeText(file.fileSize)].filter(Boolean).join(' · ')),
  );

  const play = element('button', 'Descargar y jugar');
  play.className = 'primary';
  play.addEventListener('click', async () => {
    play.disabled = true;
    play.textContent = 'Descargando…';
    try {
      playRom(await hub.download(file));
    } catch (error) {
      browserStatus.textContent = ipcErrorMessage(error);
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
// Kept here so the pause menu can offer cloud buttons without asking the
// main process every time it opens.
let signedIn = false;
hub.account().then((account) => {
  signedIn = Boolean(account);
  // Android's check at start-up: a session that died while the app was
  // closed is found now, not at the first sync that fails.
  if (account) hub.saves().catch(() => {});
});

// Android's alert, word for word but "este equipo" (romHackHubAccount.ts,
// setSessionRejectedHandler). The main process has already forgotten the
// session; this puts the account screen back to signed out.
hub.onSessionRejected(async () => {
  signedIn = false;
  session.hidden = true;
  loginForm.hidden = false;
  totpForm.hidden = true;
  cloudSaves.replaceChildren();
  accountStatus.textContent = '';
  const choice = await hub.ask({
    title: 'Tu sesión se cerró',
    message:
      'RomHack Hub ya no reconoce la sesión de este equipo (se cerró desde la web, cambiaste la ' +
      'contraseña o caducó). Tus guardados no se están sincronizando con la nube. Vuelve a ' +
      'iniciar sesión para seguir.',
    buttons: ['Iniciar sesión', 'Ahora no'],
  });
  if (choice === 0) {
    pauseGame(); // nothing without a game running
    document.getElementById('account-open').click();
  }
});

function showSession(username) {
  signedIn = true;
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
    saves = (await hub.saves()).filter((save) => !isOtherPlatformState(save));
  } catch (error) {
    accountStatus.textContent = ipcErrorMessage(error);
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

// The Android app keeps its 3DS states in slots 10-13 (src/save3ds.js): Azahar's
// state format is not portable between platforms, so they can never load here
// and are not listed. Slot 99, the game's own save, is shared and stays.
const isOtherPlatformState = (save) => save.slot >= 10 && save.slot !== GAME_SAVE_SLOT;

// Slot -1 is the in-game battery save; 0-3 are whole-machine states, and
// Android's 3 is its automatic one. Naming them matters now that both kinds
// share one list: bringing a state down and writing it over the battery
// save would corrupt the cartridge.
function slotLabel(slot) {
  if (slot === GAME_SAVE_SLOT) return 'Partida guardada';
  if (slot === 3) return 'Estado automático';
  return `Slot ${slot + 1}`;
}

function saveRow(save) {
  const row = document.createElement('li');
  const title = element('div', undefined, 'title');
  title.append(
    element('strong', slotLabel(save.slot)),
    element('span', `${fileSizeText(save.fileSize)} · ${new Date(save.updatedAt).toLocaleString()}`),
  );

  const download = element('button', 'Traer');
  download.addEventListener('click', async () => {
    const rom = loadedRom();
    if (!rom) {
      toast('Abre primero el juego al que pertenece este guardado.');
      return;
    }
    download.disabled = true;

    // A state goes to its own slot and waits there to be loaded from the
    // pause menu. Nothing holds those files open, so the game can keep going.
    if (save.slot !== GAME_SAVE_SLOT) {
      try {
        await hub.downloadSave({ id: save.id, savePath: emu.stateFile(save.slot) });
        toast(`${slotLabel(save.slot)} traído. Cárgalo desde el menú de pausa.`);
      } catch (error) {
        toast(ipcErrorMessage(error));
      }
      download.disabled = false;
      return;
    }

    bringGameSave(save);
  });

  // Only the cloud's copy goes: the one on this PC is untouched.
  const remove = element('button', 'Borrar');
  remove.addEventListener('click', async () => {
    if (!confirm(`¿Borrar "${slotLabel(save.slot)}" de la nube? Se borra para todos tus dispositivos; la copia de este PC se queda.`)) return;
    remove.disabled = true;
    try {
      await hub.deleteSave(save.id);
      toast('Borrado de la nube');
      loadCloudSaves();
    } catch (error) {
      toast(ipcErrorMessage(error));
      remove.disabled = false;
    }
  });

  row.append(title, download, remove);
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
    accountStatus.textContent = ipcErrorMessage(error);
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
    accountStatus.textContent = ipcErrorMessage(error);
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  await hub.logout();
  signedIn = false;
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
// The file name Android uploads the battery save under.
const GAME_SAVE_FILENAME = 'game.sav';

// A 3DS game saves a folder of files into the emulated console, not a .sav
// beside the ROM; it goes up as a zip (src/save3ds.js). The path below is
// still passed for it and simply not used.
const is3ds = (rom) => /\.(3ds|cci|cxi)$/i.test(rom);
const gameSaveFilename = (rom) => (is3ds(rom) ? 'game.zip' : GAME_SAVE_FILENAME);

const batterySavePath = (rom) => rom.replace(/\.[^.]+$/, '.sav');

// The game's own save up to the cloud: the account panel's button and the
// pause menu's. report shows the outcome wherever the button is.
async function uploadGameSave(report) {
  const rom = loadedRom();
  if (!rom) {
    report('Abre un juego primero.');
    return false;
  }
  try {
    // Keyed by "<system>:<crc32>", the same identity the Android app uses,
    // so one cartridge matches across devices -- src/hub.js builds it.
    syncedCrc = await hub.uploadSave({
      romPath: rom,
      savePath: batterySavePath(rom),
      slot: GAME_SAVE_SLOT,
      filename: gameSaveFilename(rom),
    });
    report('Partida subida.');
    return true;
  } catch (error) {
    report(ipcErrorMessage(error));
    return false;
  }
}

// And down, over the local one.
async function bringGameSave(save) {
  const rom = loadedRom();
  // The running core has to let go of the file before it can be replaced.
  // mGBA keeps the save open and writes through it for the core's whole
  // lifetime, so replacing it underneath a live game fails outright -- and
  // would be pointless anyway, since the core would write its own copy back
  // over it moments later.
  emu.close();
  try {
    await hub.downloadSave({ id: save.id, savePath: batterySavePath(rom), romPath: rom });
    toast('Guardado traído de la nube');
  } catch (error) {
    // A toast, not a panel's status line: playRom below hides the panels
    // straight away, so a message left there is never seen.
    toast(ipcErrorMessage(error));
  }
  // Reloaded either way: the game was torn down above, so leaving it down
  // on a failed download would strand the user on a dead session.
  playRom(rom);
}

document.getElementById('upload-save').addEventListener('click', async (event) => {
  event.target.disabled = true;
  if (await uploadGameSave((text) => (accountStatus.textContent = text))) loadCloudSaves();
  event.target.disabled = false;
});

// ---- Cloud in the pause menu --------------------------------------------
//
// Android's save panel (App.tsx): each state slot shows its cloud copy and
// has Subir/Bajar of its own, and the game's own save has a row with the
// same two. Fetched each time the menu opens.

// The open game's saves in the cloud.
let gameCloudSaves = [];
const cloudSaveIn = (slot) => gameCloudSaves.find((save) => save.slot === slot);

async function refreshGameCloudSaves() {
  const rom = loadedRom();
  gameCloudSaves = [];
  if (!rom || !signedIn) return;
  try {
    const key = await hub.gameKey(rom);
    gameCloudSaves = (await hub.saves()).filter((save) => save.gameKey === key);
  } catch {
    return; // offline: the menu just shows no cloud copies
  }
  if (paused && loadedRom() === rom) refreshPauseMenu();
}

// Android's handleUploadCloudSlot: what goes up is the game as it is right
// now, not what the slot holds. Same slot numbers and file names, so each
// device sees the other's slots in the same places.
async function uploadState(slot) {
  try {
    await hub.uploadSave({ romPath: loadedRom(), bytes: emu.captureState(), slot, filename: `slot${slot}.sav` });
    toast(`Slot ${slot + 1} subido a la nube`);
    refreshGameCloudSaves();
  } catch (error) {
    toast(ipcErrorMessage(error));
  }
}

// Android's handleDownloadCloudSlot: loaded straight away, and kept in the
// slot too, so its own "Cargar" brings the same state back later.
async function downloadState(slot) {
  const save = cloudSaveIn(slot);
  try {
    await hub.downloadSave({ id: save.id, savePath: emu.stateFile(slot) });
    if (!emu.loadState(slot)) throw new Error('Ese estado no se pudo cargar en este juego');
    toast(`Slot ${slot + 1} traído de la nube`);
    resumeGame();
  } catch (error) {
    toast(ipcErrorMessage(error));
  }
}

function showGameSaveRow() {
  const box = document.getElementById('game-save');
  box.hidden = !loadedRom();
  if (!signedIn) {
    box.replaceChildren(element('p', 'Inicia sesión en Cuenta para sincronizar guardados en la nube.', 'muted'));
    box.append(...importRow());
    return;
  }
  const cloud = cloudSaveIn(GAME_SAVE_SLOT);
  const label = element('span', `Guardado del juego · ${
    cloud ? `en la nube: ${new Date(cloud.updatedAt).toLocaleString()}` : 'sin guardado en la nube'}`);
  label.style.flex = '1';
  const up = element('button', 'Subir');
  up.addEventListener('click', async () => {
    up.disabled = true;
    if (await uploadGameSave(toast)) refreshGameCloudSaves();
    up.disabled = false;
  });
  const down = element('button', 'Bajar');
  down.disabled = !cloud;
  down.addEventListener('click', () => bringGameSave(cloud));
  const row = element('div', undefined, 'row');
  row.append(label, up, down);
  box.replaceChildren(row, ...importRow());
}

// A 3DS game's save from another emulator (save3ds.importTree has the
// formats). Empty for the other consoles, whose raw .sav beside the ROM
// already works.
function importRow() {
  const rom = loadedRom();
  if (!rom || !is3ds(rom)) return [];
  const label = element('span', 'Partida de otro emulador (Citra, Azahar o Checkpoint, en .zip)');
  label.style.flex = '1';
  const button = element('button', 'Importar…');
  button.addEventListener('click', () => importGameSave(rom));
  const row = element('div', undefined, 'row');
  row.append(label, button);
  return [row];
}

// Like bringGameSave: the core lets go of the save before it is replaced,
// and the game opens again either way. The one replaced goes to
// save-backups/ first.
async function importGameSave(rom) {
  if (!(await hub.pickImport())) return;
  emu.close();
  try {
    const warnings = await hub.importSave({ romPath: rom });
    toast(['Partida importada', ...warnings].join('. '));
  } catch (error) {
    toast(ipcErrorMessage(error));
  }
  playRom(rom);
}

// ---- The picture behind the game ---------------------------------------
//
// Blurred behind the game, and taken from the game itself rather than
// looked up (see "Pictures taken from the games themselves" in src/hub.js):
// a DS game's own icon, or for a Game Boy or GBA game, which carries no
// picture, its live screen -- copied onto the ambient canvas a few times a
// second by drawAmbient.
let coverToken = 0;
const ambient = document.getElementById('ambient');
const ambientContext = ambient.getContext('2d');
let ambientFrames = 0;

async function showCover(rom) {
  const token = ++coverToken;
  const cover = document.getElementById('cover');
  cover.hidden = true;
  ambient.hidden = true;
  if (!rom) return;
  if (!/\.nds$/i.test(rom)) {
    ambientFrames = 0;
    ambient.hidden = false;
    return;
  }
  let dataUrl = null;
  try {
    dataUrl = await hub.romCover(rom);
  } catch {
    return;
  }
  // Another game, or none, by the time the search came back.
  if (token !== coverToken || !dataUrl) return;
  cover.style.backgroundImage = `url("${dataUrl}")`;
  cover.hidden = false;
}

// Called with every frame drawn. One in six is plenty for a picture this
// blurred, and keeps the copy off the emulation's back.
function drawAmbient() {
  if (ambient.hidden || ambientFrames++ % 6) return;
  if (ambient.width !== canvas.width || ambient.height !== canvas.height) {
    ambient.width = canvas.width;
    ambient.height = canvas.height;
  }
  ambientContext.drawImage(canvas, 0, 0);
}

// The screen a Game Boy or GBA game is left on becomes its picture in the
// recents and the ROM folder. A DS or 3DS game has its own icon instead.
function keepLastScreen(rom) {
  if (!rom || /\.(nds|3ds|cci|cxi)$/i.test(rom)) return;
  try {
    emu.saveScreen(rom, canvas.toDataURL('image/png'));
  } catch {
    // A missing picture is not worth interrupting anything for.
  }
}

// ---- Feedback -----------------------------------------------------------
//
// Android's FeedbackScreen: a report with an optional screenshot, sent to
// RomHack Hub under the account, or as a guest with an optional name.
const feedbackText = document.getElementById('feedback-text');
const feedbackStatus = document.getElementById('feedback-status');
const feedbackSend = document.getElementById('feedback-send');
let feedbackImage = null;

function showFeedbackImage() {
  document.getElementById('feedback-attach').hidden = Boolean(feedbackImage);
  document.getElementById('feedback-image').hidden = !feedbackImage;
  if (!feedbackImage) return;
  document.getElementById('feedback-preview').src = feedbackImage.preview;
  document.getElementById('feedback-image-name').textContent = feedbackImage.name;
}

document.getElementById('feedback-open').addEventListener('click', () => {
  feedbackText.value = '';
  document.getElementById('feedback-name').value = '';
  feedbackImage = null;
  showFeedbackImage();
  document.getElementById('feedback-form').hidden = false;
  document.getElementById('feedback-sent').hidden = true;
  document.getElementById('feedback-guest').hidden = signedIn;
  feedbackStatus.textContent = '';
  feedbackSend.disabled = true;
  show('feedback');
  feedbackText.focus();
});

feedbackText.addEventListener('input', () => (feedbackSend.disabled = !feedbackText.value.trim()));

document.getElementById('feedback-attach').addEventListener('click', async () => {
  feedbackStatus.textContent = '';
  try {
    feedbackImage = (await emu.pickImage()) || feedbackImage;
  } catch (error) {
    feedbackStatus.textContent = ipcErrorMessage(error);
  }
  showFeedbackImage();
});

document.getElementById('feedback-remove').addEventListener('click', () => {
  feedbackImage = null;
  showFeedbackImage();
});

feedbackSend.addEventListener('click', async () => {
  feedbackSend.disabled = true;
  feedbackSend.textContent = 'Enviando…';
  feedbackStatus.textContent = '';
  try {
    await hub.sendFeedback({
      body: feedbackText.value.trim(),
      guestName: document.getElementById('feedback-name').value.trim(),
      image: feedbackImage && feedbackImage.path,
    });
    document.getElementById('feedback-form').hidden = true;
    document.getElementById('feedback-sent').hidden = false;
  } catch (error) {
    feedbackStatus.textContent = ipcErrorMessage(error);
    feedbackSend.disabled = false;
  }
  feedbackSend.textContent = 'Enviar';
});

// ---- Automatic cloud sync of the battery save --------------------------
//
// Android's autoSyncGameSave and checkGameSaveConflict (App.tsx): while
// signed in, the game's own save goes up every 45s when it changed. Before
// the first upload for a game, it is compared with the cloud's, and if the
// two differ the user picks which one wins -- pushing blind would overwrite
// progress made on the phone.
const CLOUD_SYNC_INTERVAL_MS = 45_000;

// The CRC the cloud holds as of the last upload or download, and whether
// the comparison has been settled for the game that is open. Both start over
// with every game (see startCloudSync).
let syncedCrc = null;
let syncChecked = false;
// The comparison in flight, so a timer tick during its question does not
// ask a second time.
let syncChecking = null;
// Set when the question was put off: no syncing this game until it is
// opened again, when the question comes back.
let syncPutOff = false;

// The game open, if it is one Android syncs: GBA and DS (its
// autoSyncGameSave and checkGameSaveConflict skip the Game Boy) and, here, 3DS.
// A Game Boy save can still go up by hand, with the Subir buttons.
function syncedRom() {
  const rom = loadedRom();
  return rom && /\.(gba|nds|3ds|cci|cxi)$/i.test(rom) ? rom : null;
}

// What settle3dsSave decided before the 3DS core started, handed on to
// startCloudSync so the question is not asked twice.
let settled3ds = null;

function startCloudSync() {
  syncedCrc = null;
  syncChecked = false;
  syncChecking = null;
  syncPutOff = false;
  const settled = settled3ds && settled3ds.rom === loadedRom() ? settled3ds : null;
  settled3ds = null;
  if (settled) {
    ({ crc: syncedCrc, putOff: syncPutOff } = settled);
    syncChecked = true;
    return;
  }
  if (signedIn) checkCloudSave();
}

function checkCloudSave() {
  if (!syncChecking) {
    // Cleared only if still the current one: taking the cloud's save
    // reopens the game, which starts a comparison of its own.
    const check = compareWithCloud().finally(() => {
      if (syncChecking === check) syncChecking = null;
    });
    syncChecking = check;
  }
  return syncChecking;
}

async function compareWithCloud() {
  const rom = syncedRom();
  if (!rom) return;
  const savePath = batterySavePath(rom);
  let status;
  try {
    status = await hub.saveStatus({ romPath: rom, savePath, slot: GAME_SAVE_SLOT });
  } catch {
    return; // offline: the next tick tries again
  }
  if (loadedRom() !== rom) return;

  if (!status.remote) {
    syncChecked = true; // nothing up there yet; the next tick creates it
    return;
  }
  if (status.localCrc === status.remote.crc) {
    syncedCrc = status.remote.crc;
    syncChecked = true;
    return;
  }

  const choice = await askWhichSave(status);
  // Closed, or switched to another game, while the question was up.
  if (loadedRom() !== rom) return;
  if (choice === 'later') {
    syncPutOff = true;
    return;
  }
  const keepCloud = choice === 'cloud';

  try {
    if (keepCloud) {
      // As with "Traer": the core has to let go of the file first, and
      // reopening runs this comparison again, which then finds them equal.
      emu.close();
      await hub.downloadSave({ id: status.remote.id, savePath, romPath: rom });
      toast('Guardado traído de la nube');
      playRom(rom);
    } else if (status.localCrc !== null) {
      syncedCrc = await hub.uploadSave({ romPath: rom, savePath, slot: GAME_SAVE_SLOT, filename: gameSaveFilename(rom) });
      syncChecked = true;
    } else {
      syncChecked = true; // no local save and the cloud's declined
    }
  } catch (error) {
    toast(ipcErrorMessage(error));
    if (keepCloud) playRom(rom);
  }
}

// Which side wins when the game's save and the cloud's differ: 'cloud',
// 'local' or 'later'. Asked in the same words wherever it comes up.
async function askWhichSave(status) {
  const date = new Date(status.remote.updatedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false });
  // Android's alert cannot be dismissed without an answer; this dialog can
  // (Esc, the X), so the last button is what dismissing means. Here that is
  // "later" rather than either side -- a closed window is not a choice to
  // overwrite anything.
  if (status.localCrc === null) {
    const choice = await hub.ask({
      title: 'Guardado en la nube encontrado',
      message: `Este juego no tiene datos locales, pero sí un guardado en la nube del ${date}. ¿Descargarlo?`,
      buttons: ['Descargar', 'No'],
    });
    return choice === 0 ? 'cloud' : 'local';
  }
  const choice = await hub.ask({
    title: 'El guardado de este juego no coincide con la nube',
    message: `La nube tiene una versión del ${date}. ¿Cuál quieres conservar?`,
    buttons: ['La nube', 'Este equipo', 'Más tarde'],
  });
  return ['cloud', 'local', 'later'][choice];
}

// A 3DS game's save is files in the console's SD card, which the core holds
// open from the moment it starts: so a save that has to come down from the
// cloud is put in place BEFORE the core exists, here, instead of closing a
// running game, replacing the files and reopening it as the other consoles
// do. It also avoids a trap: a game that has just booted may already have
// written a blank save, which would turn "nothing local, download?" into
// "which one wins?", with a way to overwrite the cloud's real save.
//
// Anything that goes wrong (offline, a ROM that cannot be identified) just
// lets the game open; the comparison after it starts tries again.
async function settle3dsSave(rom) {
  settled3ds = null;
  if (!signedIn) return;
  const savePath = batterySavePath(rom);
  let status;
  try {
    status = await hub.saveStatus({ romPath: rom, savePath, slot: GAME_SAVE_SLOT });
  } catch {
    return; // offline, or a ROM it cannot identify: the game opens with what is here
  }

  // The CRC this PC and the cloud agree on, once they do; null while nothing
  // is known to match, so the first periodic upload decides.
  let crc = null;
  let putOff = false;
  if (!status.remote) {
    // Nothing up there yet; the first upload creates it.
  } else if (status.localCrc === status.remote.crc) {
    crc = status.remote.crc;
  } else {
    const choice = await askWhichSave(status);
    putOff = choice === 'later';
    try {
      if (choice === 'cloud') {
        await hub.downloadSave({ id: status.remote.id, savePath, romPath: rom });
        crc = status.remote.crc;
        toast('Guardado traído de la nube');
      } else if (choice === 'local' && status.localCrc !== null) {
        crc = await hub.uploadSave({ romPath: rom, savePath, slot: GAME_SAVE_SLOT, filename: gameSaveFilename(rom) });
      }
    } catch (error) {
      toast(ipcErrorMessage(error));
      // The cloud's was chosen and could not be put in place: syncing now
      // would upload this PC's over the very save the user wanted.
      putOff = choice === 'cloud';
    }
  }
  settled3ds = { rom, crc, putOff };
}

// The save of a 3DS game that has just been closed, up to the cloud: nothing
// is writing to it any more, so it goes without waiting for it to settle.
function uploadOnExit(rom) {
  if (!rom || !is3ds(rom) || !signedIn || !syncChecked || syncPutOff) return;
  hub
    .syncSave({
      romPath: rom,
      savePath: batterySavePath(rom),
      slot: GAME_SAVE_SLOT,
      filename: gameSaveFilename(rom),
      lastCrc: syncedCrc,
      settled: true,
    })
    .then((crc) => {
      syncedCrc = crc;
    })
    .catch(() => {});
}

// Closing the window mid-game: the core is still running here, so this is the
// ordinary periodic upload (which skips a save touched a moment ago) rather
// than a forced one. The main process holds the quit until it finishes.
window.addEventListener('beforeunload', () => {
  const rom = loadedRom();
  if (rom && is3ds(rom) && signedIn && syncChecked && !syncPutOff) {
    hub.syncSave({
      romPath: rom,
      savePath: batterySavePath(rom),
      slot: GAME_SAVE_SLOT,
      filename: gameSaveFilename(rom),
      lastCrc: syncedCrc,
    }).catch(() => {});
  }
});

async function syncCloudSave() {
  const rom = syncedRom();
  if (!rom || !signedIn || syncPutOff) return;
  // Signed in after the game opened: settle the comparison first.
  if (!syncChecked) return checkCloudSave();
  try {
    syncedCrc = await hub.syncSave({
      romPath: rom,
      savePath: batterySavePath(rom),
      slot: GAME_SAVE_SLOT,
      filename: gameSaveFilename(rom),
      lastCrc: syncedCrc,
    });
  } catch {
    // Best effort, like Android's: the next tick or the button retries.
  }
}

setInterval(syncCloudSave, CLOUD_SYNC_INTERVAL_MS);
document.addEventListener('visibilitychange', () => document.hidden && syncCloudSave());

document.getElementById('account-open').addEventListener('click', async () => {
  show('account');
  const account = await hub.account();
  if (account) showSession(account.username);
});

loadPlatforms();
checkForUpdate();
