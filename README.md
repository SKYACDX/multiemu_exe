# multiemu (Windows)

Port de escritorio de [multiemu](https://github.com/SKYACDX/multiemu).
Electron + un addon nativo N-API sobre los mismos nÃºcleos de emulaciÃ³n que
usa la app de Android.

Estado: **Game Boy funcionando** (vÃ­deo + teclado). GBA y NDS pendientes.

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
npm run vendor:melonds # clona melonDS y le aplica los parches
npm run build:mgba     # una vez cada uno; tardan unos minutos
npm run build:melonds
npm start              # compila los addons y abre la app
npm test               # smoke test de los dos puentes nativos
```

`electron . ruta\a\rom.gb` arranca directo en esa ROM.

Controles: flechas, `X` = A, `Z` = B, `S` = X, `A` = Y, `Q` = L, `W` = R,
`Shift` = Select, `Enter` = Start. En DS la pantalla táctil es la mitad
inferior: se usa con el ratón.

## Estructura

| Ruta | QuÃ© es |
|---|---|
| `vendor/multiemu` | SubmÃ³dulo del repo compartido. `core/gb` se compila desde ahÃ­, no se copia: una sola fuente de verdad para el nÃºcleo. |
| `src/native/gb_addon.cpp` | Puente N-API. Delgado a propÃ³sito â€” el equivalente del JNI de Android, sin lÃ³gica de emulaciÃ³n propia. |
| `src/preload.js` | Carga los addons, elige núcleo por extensión y traduce nombres de botón a los ordinales de cada uno. El objeto nativo no cruza a la página; solo datos. |
| `src/renderer/` | Canvas, ritmo de frames y teclado. |

## Notas de port

`docs/desktop-port-handoff.md` en el repo compartido tiene las trampas que
ya se pisaron en Android y siguen valiendo aquÃ­. Las dos que muerden en
escritorio y aÃºn no aplican porque falta el NDS:

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
- cmake-js compila los addons con la CRT estática (`/MT`) y mGBA usa `/MD`
  por defecto. Como el `cmake_minimum_required(3.1)` de mGBA deja CMP0091
  en OLD, `CMAKE_MSVC_RUNTIME_LIBRARY` se ignora allí y hay que poner
  `/MT` a mano en `CMAKE_C_FLAGS_RELEASE` — si no, el enlace falla con
  dos docenas de `__imp_*` sin resolver.

### Los parches de melonDS

`vendor:melonds` aplica los dos parches de Android **enteros** más uno
nuestro. Aplicarlos enteros es correcto aquí solo por una razón: este build
usa `ENABLE_OGLRENDERER=OFF`, así que ninguno de los ficheros de OpenGL
llega a compilar. Eso vuelve inofensivo el cambio del swizzle del
compositor de `.bgr` a `.rgb`, que en escritorio pintaría los azules en
naranja, y a cambio salen gratis los arreglos de portabilidad a MSVC del
mismo commit. **Si algún día se enciende el renderer de OpenGL, hay que
revertir ese swizzle antes.**

El parche propio (`0003`) quita un `#include <dirent.h>` de
`FATStorage.cpp` que no se usa: todo el trabajo de directorios del fichero
va por FatFs (`f_opendir`), y MSVC no tiene `dirent.h`.

### Sin JIT, y por qué

melonDS decide si puede construir su JIT probando `__x86_64__`, que MSVC no
define, así que su `cmake_dependent_option` lo apaga solo por mucho que se
pase `-DENABLE_JIT=ON` — la caché guarda el valor pedido, no el usado. Por
eso `ds_addon` **no** define `JIT_ENABLED`: hacerlo sería el desajuste de
`sizeof(NDS)` del handoff, en sentido contrario.

No hace falta de momento. El intérprete mueve SoulSilver a ~108fps en este
equipo, casi el doble de tiempo real. Si alguna vez hiciera falta, el
camino es compilar melonDS con clang-cl, que sí define las macros de
arquitectura al estilo GCC y acepta el `__attribute__((packed))` de
`TinyVector.h`, manteniendo compatibilidad de ABI con los addons de MSVC.

### Por qué RomHack Hub vive en el proceso principal

`src/shared.ts` empaqueta con esbuild el TypeScript del repo Android tal
cual: los tres clientes de API, los parcheadores IPS/UPS/BPS, CRC32 y el
descompresor. Es TypeScript plano sobre `fetch`, sin nada de React Native,
así que el `.exe` y el móvil hablan con el backend por el mismo código.

Se empaqueta para el **proceso principal**, no para la página, por dos
razones concretas que costaron encontrarse:

- Un renderer con origen `file://` manda `Origin: null`, y además Chromium
  **no le deja cargar imágenes remotas** — las carátulas salían en blanco.
  Por eso `hub:cover` las baja en el proceso principal y las devuelve como
  `data:`.
- El token de la cuenta no tiene por qué llegar nunca a la página. Se
  guarda cifrado con `safeStorage`, que lo delega en el almacén del sistema
  operativo; si no hay ninguno disponible, simplemente no se persiste.

### Detalles del backend encontrados al conectar

Ninguno bloquea, pero conviene que la sesión web los sepa:

- `GET /api/v1/app/releases?platform=windows` **no filtra**: devuelve
  también las releases de Android, y todas traen `platform: null`. Por eso
  el aviso de versión exige que el campo diga `WINDOWS` y trata `null` como
  "no es de esta plataforma": así una release de Android nunca se ofrece
  como actualización del `.exe`, y el aviso empieza a funcionar solo en
  cuanto el backend exponga el campo.
- El catálogo de **HackRoms está vacío** (`/hacks` y `/games` devuelven 0).
  Los parcheadores ya están empaquetados, así que la pantalla se añade el
  día que haya contenido que mostrar.
- `RomHackHubFile.platform` y `coverImageUrl` están tipados como
  obligatorios pero llegan `null` en la práctica. La interfaz lo trata como
  opcional.
- El `API_BASE` del cliente compartido omite el `www`, así que cada llamada
  se come un 308. Funciona (fetch sigue la redirección) pero se paga un
  viaje de más.
