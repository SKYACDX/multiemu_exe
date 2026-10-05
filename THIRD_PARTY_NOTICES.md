# Avisos de terceros

multiemu se distribuye bajo la GPL-3.0-or-later (ver `LICENSE`). Incluye o enlaza el siguiente software de terceros, cada uno bajo su propia licencia. Los parches que aplicamos están en `patches/` y en el submódulo `vendor/multiemu/patches/`.

| Componente | Para qué | Licencia | Origen |
|---|---|---|---|
| melonDS (incluye teakra y libslirp) | Nintendo DS / DSi | GPL-3.0 (teakra: MIT, libslirp: BSD-3-Clause) | https://github.com/melonDS-emu/melonDS |
| mGBA | Game Boy Advance | MPL-2.0 | https://github.com/mgba-emu/mgba |
| Azahar | Nintendo 3DS | GPL-2.0-or-later | https://github.com/azahar-emu/azahar |
| Electron | Ventana y runtime de escritorio | MIT | https://github.com/electron/electron |

El código fuente exacto de cada componente se obtiene con los scripts `vendor:*` de `package.json`, que fijan la versión (tag) y aplican los parches.
