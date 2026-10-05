# Contributing

Thanks for wanting to help. multiemu is GPL-3.0-or-later; by sending a
change you agree to license it the same way.

- **Bugs and ideas:** open an [issue](https://github.com/SKYACDX/multiemu_exe/issues/new/choose).
  Never attach or link game ROMs, BIOS or firmware files.
- **Code:** fork, branch, and open a pull request against `main`. Build it
  as described in the [README](README.md#building-from-source) and run
  `npm test` before sending.
- **Emulation cores** (melonDS, mGBA, Azahar) are fetched at pinned tags and
  patched by the `vendor:*` scripts. A change to a core goes in as a new
  file in [`patches/`](patches/) and in that script's list, never as an edit
  under `third_party/` — CI builds from the patches, so an edit that isn't
  one isn't in the release.
- **Game Boy core and shared code** live in the [Android repository](https://github.com/SKYACDX/multiemu)
  (`vendor/multiemu` here is a submodule of it): send those changes there.
- The developer notes are in Spanish, in [README.es.md](README.es.md);
  issues and pull requests are welcome in English or Spanish.

---

# Cómo contribuir (español)

Fallos e ideas en los [issues](https://github.com/SKYACDX/multiemu_exe/issues/new/choose),
sin ROMs. Código por pull request contra `main`, con `npm test` pasando. Los
cambios a los núcleos van como parche nuevo en `patches/`, y los del núcleo
de Game Boy y el código compartido, en el [repo de Android](https://github.com/SKYACDX/multiemu).
