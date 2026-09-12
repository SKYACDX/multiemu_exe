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
 * The API has no `platform` field on a release at all -- not null, absent --
 * and its documented `?platform=` filter does not filter, so this reads the
 * two signals that are actually there:
 *
 *   - the real filename, which the signed download URL carries in its
 *     content-disposition (multiemu-1.8.apk);
 *   - minAndroidSdk, which docs/app-listing-api.md says is omitted for a
 *     Windows release and is 24 on every Android one published so far.
 *
 * Guessing wrong in the safe direction matters more than being clever: a
 * release that looks like neither is treated as not Windows, so an Android
 * build can never offer itself as an update to the desktop app.
 */
export function isWindowsRelease(release: AppRelease): boolean {
  const filename = /filename%3D%22([^%]+)%22/i.exec(release.apkUrl || '')?.[1];
  if (filename) return filename.toLowerCase().endsWith('.exe');
  return release.minAndroidSdk === null || release.minAndroidSdk === undefined;
}
