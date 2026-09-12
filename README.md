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
npm start              # compila el addon y abre la app
npm test               # smoke test del puente nativo
```

`electron . ruta\a\rom.gb` arranca directo en esa ROM.

Controles: flechas, `X` = A, `Z` = B, `Shift` = Select, `Enter` = Start.

## Estructura

| Ruta | Qué es |
|---|---|
| `vendor/multiemu` | Submódulo del repo compartido. `core/gb` se compila desde ahí, no se copia: una sola fuente de verdad para el núcleo. |
| `src/native/gb_addon.cpp` | Puente N-API. Delgado a propósito — el equivalente del JNI de Android, sin lógica de emulación propia. |
| `src/preload.js` | Carga el addon y lo expone al renderer por `contextBridge`. El objeto nativo no cruza; solo datos. |
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
