// Everything this app reuses from the Android repo, re-exported through one
// entry point for esbuild to bundle. None of it is rewritten here: these
// modules are plain TypeScript over fetch, with nothing React Native in
// them, so the desktop app and the phone app talk to RomHack Hub through
// exactly the same client.
//
// Bundled for the MAIN process, not the renderer. Two reasons: a renderer on
// a file:// origin sends `Origin: null` and would have to be let through
// CORS, and the account token never has to reach the page at all.
export * from '../vendor/multiemu/app/src/api/romHackHub';
export * from '../vendor/multiemu/app/src/api/romHackHubAccount';
export * from '../vendor/multiemu/app/src/api/themes';
export * from '../vendor/multiemu/app/src/patchers';
export { extractFromZip } from '../vendor/multiemu/app/src/zip';
export { crc32 } from '../vendor/multiemu/app/src/patchers/crc32';

import type { AppRelease } from '../vendor/multiemu/app/src/api/romHackHub';

/**
 * The one call this app needs that the Android client doesn't have.
 * `getAppInfo()` deliberately reports only the newest ANDROID release as
 * `latestRelease` -- that is what stops a desktop release from nagging phone
 * users -- so the desktop update check has to read the release list itself.
 *
 * Added here rather than in the shared repo because it is only useful to a
 * non-Android build; move it over if a second one ever appears.
 *
 * Note the `www`: the shared client's own API_BASE omits it and eats a 308
 * redirect on every call. Harmless (fetch follows it) but worth not
 * repeating in new code.
 */
export async function listAppReleases(params: {
  platform?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ releases: AppRelease[] }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const response = await fetch(`https://www.emulatornds.online/api/v1/app/releases?${query}`);
  if (!response.ok) {
    throw new Error(`No se pudo consultar las versiones (HTTP ${response.status})`);
  }
  return response.json();
}

/**
 * Which platform a release is for.
 *
 * `platform` is the answer when it is there, and since 2026-09-12 it is.
 * The filename fallback stays because it already earned its keep: the field
 * was specified and merged days before it actually reached production, and
 * during that window every release came back without it. Reading the real
 * filename out of the signed download URL's content-disposition
 * (multiemu-1.0.exe) covers that case, and minAndroidSdk -- omitted on a
 * Windows release -- covers the one after it.
 *
 * Guessing wrong in the safe direction matters more than being clever: a
 * release that looks like neither is treated as not Windows, so an Android
 * build can never offer itself as an update to the desktop app.
 */
export function isWindowsRelease(release: AppRelease): boolean {
  if (release.platform) return release.platform.toUpperCase() === 'WINDOWS';

  const filename = /filename%3D%22([^%]+)%22/i.exec(release.apkUrl || '')?.[1];
  if (filename) return filename.toLowerCase().endsWith('.exe');
  return release.minAndroidSdk === null || release.minAndroidSdk === undefined;
}
