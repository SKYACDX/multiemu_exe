# multiemu (Windows)

Port de escritorio de [multiemu](https://github.com/SKYACDX/multiemu).
Electron + un addon nativo N-API sobre los mismos núcleos de emulación que
usa la app de Android.

Estado: **Game Boy funcionando** (vídeo + teclado). GBA y NDS pendientes.

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
npm run build:slirp    # la pila de red para el internet del DS
npm start              # compila los addons y abre la app
npm test               # smoke test de los tres puentes nativos
npm run dist           # genera el instalador en dist/
```

`electron . ruta\a\rom.gb` arranca directo en esa ROM.

Controles por defecto: flechas, `X` = A, `Z` = B, `S` = X, `A` = Y, `Q` = L,
`W` = R, `Shift` = Select, `Enter` = Start. También sirve cualquier mando
que el navegador reconozca con el mapeo estándar, sin configurar nada.

**Todo eso se puede reasignar** desde el botón «Controles»: teclado y mando
por separado, botón a botón. Ahí mismo se elige si las dos pantallas del DS
salen **una sobre otra** o **lado a lado**; en las dos, la pantalla táctil
es la segunda y se usa con el ratón.

Comprueba si hay una versión nueva para Windows al arrancar y cada dos
horas, para que una sesión larga también se entere. Si la hay,
sale una barra arriba de la ventana — visible también jugando, no solo en
el menú — más una notificación del sistema. «Ocultar» la calla hasta que
salga una más nueva. El botón lleva a la página de descarga y no al fichero
directo, porque la URL firmada caduca a los cinco minutos.

`Esc` durante el juego abre el **menú de pausa**, que es donde está todo lo
que hace falta sin cerrar la partida: velocidad (0,5x a 4x, con la
velocidad real medida en fps), guardar y cargar estado con la fecha del
último, los guardados en la nube de ese juego concreto, los mismos
controles y pantallas, y salir al menú.

Fuera de 1x el sonido se acelera con el juego y sube o baja de tono, como
en cualquier emulador: `audio.js` remuestrea las muestras que el núcleo
produce de más (o de menos) al ritmo de salida.

Las asignaciones y el diseño viven en `settings.json` dentro de la carpeta
de datos de la app, junto a los guardados — un JSON normal, editable a mano
si hace falta.

`F5` guarda el estado completo de la máquina y `F8` lo restaura, junto a la
ROM en un `.state`. En Game Boy no hay: ese núcleo todavía no lo soporta.

> El audio de Game Boy sale del APU nuevo, que vive en la rama **`gb-apu`**
> del repo compartido, no en `master`. El submódulo apunta a esa rama a
> propósito; cuando se fusione, basta con mover el puntero.

## Estructura

| Ruta | Qué es |
|---|---|
| `vendor/multiemu` | Submódulo del repo compartido. `core/gb` se compila desde ahí, no se copia: una sola fuente de verdad para el núcleo. |
| `src/native/gb_addon.cpp` | Puente N-API. Delgado a propósito — el equivalente del JNI de Android, sin lógica de emulación propia. |
| `src/preload.js` | Carga los addons, elige núcleo por extensión y traduce nombres de botón a los ordinales de cada uno. El objeto nativo no cruza a la página; solo datos. |
| `src/renderer/` | Canvas, ritmo de frames y teclado. |

## Notas de port

`docs/desktop-port-handoff.md` en el repo compartido tiene las trampas que
ya se pisaron en Android y siguen valiendo aquí. Las dos que muerden en
escritorio y aún no aplican porque falta el NDS:

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

### Internet del DS

Va por libslirp en modo indirecto: melonDS hace de router virtual con NAT
sobre sockets normales del sistema. `Net_PCap` (modo directo) también
funcionaría en escritorio, al contrario que en Android, pero exige libpcap
instalado y elegir un adaptador a mano, así que slirp es el que funciona
sin preparar nada.

No se usa el objetivo `net-utils` de melonDS: ese arrastra `Net_PCap`
(libpcap) y `LAN`/`Netplay`/`LocalMP` (ENet), que aquí no hacen falta. Solo
se compilan `Net.cpp`, `Net_Slirp.cpp` y `PacketDispatcher.cpp` dentro del
addon, más `slirp.lib`.

El parche `0004` es lo que hace falta para MSVC: las ramas de Windows de
`Net_Slirp` están detrás de `__WIN32__`, que solo define MinGW — todo lo
que necesitan (WSAPoll, el apaño de `clock_gettime`) ya estaba escrito, MSVC
simplemente no lo veía. Y el shim de glib que trae libslirp usa
`__builtin_expect` y `__builtin_unreachable`, que MSVC no tiene.

`LIBSLIRP_STATIC_BUILD` hay que repetirlo a mano en el addon por la misma
razón que `JIT_ENABLED`: libslirp lo declara `PUBLIC` en su objetivo, pero
aquí se importa el `.lib` ya compilado y una librería importada no propaga
nada. Sin él, `libslirp.h` marca todo como `__declspec(dllimport)` y el
enlace falla con `__imp_slirp_*`.

**Compila, enlaza y no rompe nada, pero la conexión real no está
verificada en escritorio.** Para comprobarla hace falta entrar a los
ajustes de la CWF de Nintendo desde dentro de un juego compatible y poner
un DNS comunitario a mano — los pasos exactos están en el changelog de la
v1.8 de Android.

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

- **Una release no trae campo `platform` en absoluto** — no es `null`, no
  está — y el filtro `?platform=windows` que documenta la API no filtra.
  El aviso de versión no lo espera: deduce la plataforma del nombre real
  del fichero, que la URL firmada de descarga lleva en su
  `content-disposition` (`multiemu-1.8.apk`), y si no hay nombre cae en
  `minAndroidSdk`, que según la propia documentación se omite en una
  release de Windows. Ante la duda, «no es mía»: una release de Android
  nunca puede ofrecerse como actualización del `.exe`. Verificado contra
  las 10 releases publicadas, y las dos direcciones fijadas en el test.
  Si algún día el backend expone `platform`, esto se puede simplificar.
- El catálogo de **HackRoms está vacío** (`/hacks` y `/games` devuelven 0).
  Los parcheadores ya están empaquetados, así que la pantalla se añade el
  día que haya contenido que mostrar.
- `RomHackHubFile.platform` y `coverImageUrl` están tipados como
  obligatorios pero llegan `null` en la práctica. La interfaz lo trata como
  opcional.
- El `API_BASE` del cliente compartido omite el `www`, así que cada llamada
  se come un 308. Funciona (fetch sigue la redirección) pero se paga un
  viaje de más.

### Empaquetado y firma

`npm run dist` deja un instalador NSIS en `dist/` (~107MB). Los addons
nativos van fuera del asar (`asarUnpack`), porque Electron no puede cargar
un `.node` desde dentro, y `npmRebuild` está apagado: los compila cmake-js
contra el ABI de Electron, no npm.

**El `.exe` no va firmado.** Sin firma, SmartScreen avisa en cada descarga
hasta que el binario acumula reputación. La opción barata y real es Azure
Trusted Signing (~10 USD/mes); un certificado OV clásico cuesta varias
veces eso y tampoco arranca con reputación. Es una decisión de dinero, no
técnica, y conviene tomarla antes de publicar el primer release.
