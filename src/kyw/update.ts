// Update notice for an APK installed outside a store. SolSentry publishes one small JSON file with the
// newest build; the app compares its own versionCode and, when a newer one exists, offers a link that
// opens in the browser. The app never downloads or installs anything itself (no install permission).
// A missing, slow or malformed file shows nothing: the notice is a convenience, never a blocker.

/** Where the newest build is described. Served by solsentry.app (request to dev, 12/10). */
export const LATEST_URL = 'https://solsentry.app/app/latest.json'

export interface LatestBuild {
  versionCode: number
  /** Short public name, e.g. "0.1.19". */
  name: string
  /** https link to the APK, on a host SolSentry controls. */
  url: string
  /** sha256 of the APK, lowercase hex, when published. */
  sha256: string | null
  /** One line on what changed, when published. */
  notes: string | null
}

/** Hosts a download link may point to: SolSentry's own, or a GitHub release. */
const DOWNLOAD_HOSTS = /^(?:[a-z0-9-]+\.)*solsentry\.app$|^github\.com$/

function downloadHost(url: string): string | null {
  const m = /^https:\/\/([a-z0-9.-]+)(?::\d{1,5})?\//i.exec(url)
  return m ? m[1].toLowerCase() : null
}

/** The published file, checked field by field; null when anything required is wrong. */
export function parseLatest(body: unknown): LatestBuild | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const code = b.versionCode
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 1) return null
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40) return null
  if (typeof b.url !== 'string') return null
  const host = downloadHost(b.url)
  if (!host || !DOWNLOAD_HOSTS.test(host)) return null
  const sha256 = typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(b.sha256) ? b.sha256.toLowerCase() : null
  const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 200) : null
  return { versionCode: code, name: b.name.trim(), url: b.url, sha256, notes }
}

/** The build to offer, or null: only a strictly newer one, and not one the user already set aside. */
export function updateToOffer(
  installed: number | null,
  latest: LatestBuild | null,
  dismissed: number | null,
): LatestBuild | null {
  if (installed === null || latest === null) return null
  if (latest.versionCode <= installed) return null
  if (dismissed !== null && dismissed >= latest.versionCode) return null
  return latest
}
