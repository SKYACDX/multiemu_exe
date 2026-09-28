// The main menu's ways back into a game, after Android's home screen
// (HomeScreen.tsx and FolderScreen.tsx in the shared repo): the games
// opened recently, one click to reopen, and a folder of ROMs to pick from.
// A .zip opens anywhere a ROM does, unpacked first by the main process.
//
// Android keeps its own copy of every ROM it opens. Here the recents are
// just paths: the save lives next to the ROM, and a copy would split it
// from the one the user already has.

// Android's MAX_CACHE_ENTRIES (RomLibraryModule.kt).
const RECENTS_LIMIT = 40;

const SYSTEM_LABELS = { gb: 'GB', gbc: 'GBC', gba: 'GBA', nds: 'NDS' };
// Android's badge colours, per system.
const SYSTEM_COLORS = { gb: '#4a90d9', gbc: '#5cb85c', gba: '#c2536a', nds: '#8e5cd9' };

const extensionOf = (file) => file.slice(file.lastIndexOf('.') + 1).toLowerCase();
const fileName = (file) => file.slice(Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) + 1);

// partner, when given, is the second player's game.
async function openRomFile(file, partner) {
  try {
    const rom = await hub.unpackRom(file);
    playRom(rom, partner && (await hub.unpackRom(partner)));
  } catch (error) {
    status.textContent = ipcErrorMessage(error);
  }
}

// ---- Covers -----------------------------------------------------------
//
// The same covers as behind the game (hub:rom-cover in src/hub.js), one at
// a time once the list is on screen: a first start with forty recents
// neither holds the menu up nor fires forty searches at once. An image
// with nothing found just stays a grey square.
let coverQueue = Promise.resolve();

function coverImage(file) {
  const image = element('img', undefined, 'cover');
  image.alt = '';
  coverQueue = coverQueue.then(async () => {
    try {
      const dataUrl = await hub.romCover(file);
      if (dataUrl) image.src = dataUrl;
    } catch {
      // No cover is not worth a message.
    }
  });
  return image;
}

// ---- Recents ----------------------------------------------------------

function recentRoms() {
  return settings.read().recentRoms || [];
}

// Called by playRom for a single game: to the front, without a duplicate.
// Windows paths are case-insensitive, so the comparison is too.
function rememberRom(romPath) {
  const others = recentRoms().filter((rom) => rom.toLowerCase() !== romPath.toLowerCase());
  settings.write({ ...settings.read(), recentRoms: [romPath, ...others].slice(0, RECENTS_LIMIT) });
  showRecents();
}

function forgetRom(romPath) {
  settings.write({ ...settings.read(), recentRoms: recentRoms().filter((rom) => rom !== romPath) });
  showRecents();
}

function recentCard(romPath, size) {
  const system = extensionOf(romPath);
  const card = element('div', undefined, 'recent');
  card.style.borderTopColor = SYSTEM_COLORS[system] || '#555';
  card.title = romPath;

  const top = element('div', undefined, 'recent-top');
  const badge = element('span', SYSTEM_LABELS[system] || system.toUpperCase(), 'badge');
  badge.style.background = SYSTEM_COLORS[system] || '#555';
  const remove = element('button', '✕', 'remove');
  remove.title = 'Quitar de recientes';
  remove.addEventListener('click', (event) => {
    event.stopPropagation(); // not a click on the card, which would open it
    forgetRom(romPath);
  });
  top.append(badge, remove);

  card.append(
    top,
    coverImage(romPath),
    element('strong', fileName(romPath).replace(/\.[^.]+$/, '')),
    element('span', megabytes(size), 'muted'),
  );
  card.addEventListener('click', () => playRom(romPath));
  return card;
}

function showRecents() {
  // A ROM that was moved or deleted since just drops off the list.
  const cards = [];
  for (const romPath of recentRoms()) {
    const size = emu.fileSize(romPath);
    if (size !== null) cards.push(recentCard(romPath, size));
  }
  document.getElementById('recents').replaceChildren(...cards);
  document.getElementById('recents-empty').hidden = cards.length > 0;
}

// ---- The ROM folder ---------------------------------------------------

function romFolder() {
  return settings.read().romFolder || null;
}

function showFolderShortcut() {
  const folder = romFolder();
  document.getElementById('folder-shortcut').hidden = !folder;
  document.getElementById('folder-pick').textContent = folder ? 'Cambiar carpeta' : 'Elegir carpeta';
  if (folder) document.getElementById('folder-shortcut-name').textContent = fileName(folder) || folder;
}

function openFolder() {
  const folder = romFolder();
  document.getElementById('folder-name').textContent = fileName(folder) || folder;
  const list = document.getElementById('folder-files');
  let files;
  try {
    files = emu.listFolder(folder);
  } catch {
    files = null;
  }
  list.replaceChildren(...(files || []).map((file) => {
    const row = document.createElement('li');
    const title = element('div', undefined, 'title');
    title.append(element('strong', file.name), element('span', megabytes(file.size)));
    const play = element('button', 'Jugar', 'primary');
    play.addEventListener('click', () => openRomFile(file.path));
    row.append(coverImage(file.path), title, play);
    return row;
  }));
  document.getElementById('folder-status').textContent = !files
    ? 'No se pudo abrir la carpeta. ¿La moviste o la borraste?'
    : files.length ? '' : 'No se encontraron ROMs (.gb/.gbc/.gba/.nds/.zip) en esta carpeta.';
  show('folder');
}

document.getElementById('folder-pick').addEventListener('click', async () => {
  const folder = await emu.pickFolder();
  if (!folder) return;
  settings.write({ ...settings.read(), romFolder: folder });
  showFolderShortcut();
  openFolder();
});

document.getElementById('folder-shortcut').addEventListener('click', openFolder);

showRecents();
showFolderShortcut();
