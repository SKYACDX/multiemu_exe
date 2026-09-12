# multiemu (Windows)

Port de escritorio de [multiemu](https://github.com/SKYACDX/multiemu).
Electron + un addon nativo N-API sobre los mismos n√∫cleos de emulaci√≥n que
usa la app de Android.

Estado: **Game Boy funcionando** (v√≠deo + teclado). GBA y NDS pendientes.

## Requisitos

- Node 22+
- Visual Studio 2022 con el workload de C++ **y** el componente CMake
- `cmake` en el `PATH` (el de VS vale:
  `C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin`)

## Uso

```
git clone --recurse-submodules https://github.com/SKYACDX/multiemu_exe.git
npm install
npm run vendor:mgba    # clona mGBA en el tag fijado (third_party/ no se versiona)
npm run build:mgba     # una vez; tarda unos minutos
npm start              # compila los addons y abre la app
npm test               # smoke test de los dos puentes nativos
```

`electron . ruta\a\rom.gb` arranca directo en esa ROM.

Controles: flechas, `X` = A, `Z` = B, `Shift` = Select, `Enter` = Start,
`A` = L, `S` = R.

## Estructura

| Ruta | Qu√© es |
|---|---|
| `vendor/multiemu` | Subm√≥dulo del repo compartido. `core/gb` se compila desde ah√≠, no se copia: una sola fuente de verdad para el n√∫cleo. |
| `src/native/gb_addon.cpp` | Puente N-API. Delgado a prop√≥sito ‚Äî el equivalente del JNI de Android, sin l√≥gica de emulaci√≥n propia. |
| `src/preload.js` | Carga los addons, elige n˙cleo por extensiÛn y traduce nombres de botÛn a los ordinales de cada uno. El objeto nativo no cruza a la p·gina; solo datos. |
| `src/renderer/` | Canvas, ritmo de frames y teclado. |

## Notas de port

`docs/desktop-port-handoff.md` en el repo compartido tiene las trampas que
ya se pisaron en Android y siguen valiendo aqu√≠. Las dos que muerden en
escritorio y a√∫n no aplican porque falta el NDS:

- El parche de melonDS (`patches/melonds/`) son **dos** commits. El segundo
  (`WifiAP`) se aplica entero. El primero mezcla lo portable (VRAM dirty
  tracking) con lo que rompe en escritorio (el swizzle `.rgb` del
  compositor) y lo que sobra (portabilidad a GLES). No hacer
  `git am *.patch` a ciegas.
- `JIT_ENABLED` cambia `sizeof(NDS)`: el define tiene que coincidir entre
  el core y este frontend o el heap se corrompe.

### Detalles del build en Windows

- `LIBMGBA_ONLY=ON` es la salida que trae el propio mGBA para no exigir
  epoxy en Windows (solo hace falta para sus frontends con GL).
- cmake-js compila los addons con la CRT est·tica (`/MT`) y mGBA usa `/MD`
  por defecto. Como el `cmake_minimum_required(3.1)` de mGBA deja CMP0091
  en OLD, `CMAKE_MSVC_RUNTIME_LIBRARY` se ignora allÌ y hay que poner
  `/MT` a mano en `CMAKE_C_FLAGS_RELEASE` ó si no, el enlace falla con
  dos docenas de `__imp_*` sin resolver.
