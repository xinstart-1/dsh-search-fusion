/**
 * dsh-search-fusion — durable config snapshot ("last known good").
 *
 * The settings page persists through the host settings service, which writes
 * the profile's `cordis.patch.yml`. That file is not durable: the desktop app's
 * fatal-recovery dialog ("禁用第三方插件、备份 profile patch 并重启") renames it
 * away, a regenerated profile starts from an empty patch, and a hand edit can
 * drop the row. Every one of those paths silently resets the user's custom
 * engines, which reads as "重启后我加的引擎又没了".
 *
 * This module keeps the same fields in a small JSON file next to the profile
 * patch and can merge them back at load time. The profile patch stays the
 * source of truth for the host; the snapshot is only a recovery copy, written
 * on every successful save and read once at plugin load.
 *
 * Deliberately dependency-free (node:fs + node:path only) so it can be unit
 * tested and imported by the host half without pulling in any DSH package.
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File name kept inside the profile directory. */
export const SNAPSHOT_FILENAME = 'dsh-search-fusion.state.json'

/** Bumped when the on-disk shape changes; older files are still readable. */
export const SNAPSHOT_VERSION = 1

/** Hard cap so a corrupted/huge file can never be loaded into memory. */
const MAX_SNAPSHOT_BYTES = 512 * 1024

/**
 * Fields a snapshot keeps and may restore. Mirrors the settings page's
 * editable surface (see routes.js `project`), plus `engineWeights` which the
 * page does not expose but the profile file may carry.
 */
export const SNAPSHOT_FIELDS = [
  'primary',
  'fallback',
  'strategy',
  'maxResults',
  'minResults',
  'cacheEnabled',
  'cacheTtlMs',
  'engineTimeoutMs',
  'locale',
  'proxy',
  'searxngInstances',
  'anysearchApiKeyEnv',
  'engineWeights',
]

/**
 * Where the snapshot lives.
 *
 * Resolution order mirrors what the launcher actually publishes, verified
 * against the running desktop host (and `dsh-restart-now`'s `resolveProfileDir`,
 * which solves the same problem):
 *
 *   1. `profileContext.dir` — launcher-provided authority, the profile root;
 *   2. `$DSH_PROFILE_DIR` — explicit override, mostly for scripts/tests;
 *   3. `$DSH_HOME/profiles/$DSH_PROFILE` — CLI-style home layout;
 *   4. `~/.dsh/profiles/desktop` — the desktop default.
 *
 * Always a PROFILE directory, never `$DSH_HOME` itself: the snapshot has to sit
 * next to the profile's `cordis.patch.yml`, which is the file it backs up.
 *
 * @param ctx - cordis context of the host half (may be a stub in tests).
 * @returns absolute path of the snapshot file.
 */
export function resolveStatePath(ctx) {
  let profileDir = ''
  try {
    const dir = ctx?.get?.('profileContext')?.dir
    if (typeof dir === 'string') profileDir = dir.trim()
  } catch {
    // Service absent or thrown: fall through to the env chain.
  }
  const env = process.env
  if (profileDir === '' && typeof env.DSH_PROFILE_DIR === 'string') profileDir = env.DSH_PROFILE_DIR.trim()
  if (profileDir === '' && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    profileDir = join(env.DSH_HOME.trim(), 'profiles', env.DSH_PROFILE?.trim() || 'desktop')
  }
  if (profileDir === '') profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
  return join(profileDir, SNAPSHOT_FILENAME)
}

/** Keep only the restorable fields, dropping undefined ones. */
export function pickSnapshotConfig(config) {
  const out = {}
  if (config === null || typeof config !== 'object') return out
  for (const key of [...SNAPSHOT_FIELDS, 'customEngines']) {
    const value = config[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * Read the snapshot.
 *
 * Never throws: a missing, unreadable, oversized or malformed file simply means
 * "no recovery copy", which must not stop the plugin from loading.
 *
 * @param path - snapshot path from {@link resolveStatePath}.
 * @param now - clock injection for tests (unused, kept for symmetry).
 * @returns `{ version, savedAt, config }` or undefined.
 */
export function readSnapshot(path) {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_SNAPSHOT_BYTES) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const config = parsed.config
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
    // A snapshot is machine-written, but a hand-edited one must not put a
    // non-list where custom-engine rows belong: the merge relies on that shape.
    if (config.customEngines !== undefined && !Array.isArray(config.customEngines)) return undefined
    return {
      version: Number.isSafeInteger(parsed.version) ? parsed.version : 0,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      config,
    }
  } catch {
    return undefined
  }
}

/**
 * Atomically replace the snapshot.
 *
 * Best effort by design: a read-only profile must not turn a successful config
 * save into an error, so failures are reported only through the return value.
 *
 * @param path - snapshot path from {@link resolveStatePath}.
 * @param config - current resolved config.
 * @param now - clock injection for tests.
 * @returns whether the file was written.
 */
export function writeSnapshot(path, config, now = new Date()) {
  const tmp = `${path}.tmp`
  try {
    const body = `${JSON.stringify({
      version: SNAPSHOT_VERSION,
      savedAt: now.toISOString(),
      config: pickSnapshotConfig(config),
    }, null, 2)}\n`
    if (body.length > MAX_SNAPSHOT_BYTES) return false
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, body)
    renameSync(tmp, path)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* nothing to clean up */ }
    return false
  }
}

/** Whether a config's custom-engine row was restored from the snapshot. */
function engineIds(config) {
  return Array.isArray(config?.customEngines)
    ? config.customEngines.map((engine) => (typeof engine?.id === 'string' ? engine.id : '')).filter(Boolean)
    : []
}

/**
 * Merge a snapshot back into the live config.
 *
 * Rules are intentionally narrow so a user's deliberate reset is never
 * resurrected:
 *
 *  - custom engines: rows in the snapshot are re-added when the live config has
 *    none at all, or when their ids are missing from a partially dropped list;
 *  - every other field: restored only when the live value still equals the
 *    schema default (i.e. the profile clearly lost the setting rather than the
 *    user choosing the default);
 *  - the snapshot is refreshed on every successful save, so an intentional
 *    "save with nothing" produces an empty snapshot and no restore next boot.
 *
 * @param current - resolved live config (already validated).
 * @param snapshot - result of {@link readSnapshot} (may be undefined).
 * @param defaults - `resolveConfig({})`, the default value of every field.
 * @returns `{ config, recovered }` where `recovered` lists the restored keys.
 */
export function mergeRecoveredConfig({ current, snapshot, defaults }) {
  const recovered = []
  const source = snapshot?.config
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { config: current, recovered }
  }
  const out = { ...current }

  // Custom engines: union by id. A row the snapshot has but the live config
  // lost is exactly the case this module exists for; an id the user deleted
  // intentionally was already removed from the snapshot by the next save.
  const liveIds = new Set(engineIds(current))
  const savedEngines = Array.isArray(source.customEngines)
    ? source.customEngines.filter((engine) => engine !== null && typeof engine === 'object')
    : []
  const missing = savedEngines.filter((engine) => {
    const id = typeof engine?.id === 'string' ? engine.id : ''
    return id !== '' && !liveIds.has(id)
  })
  if (missing.length > 0) {
    out.customEngines = [...(Array.isArray(current.customEngines) ? current.customEngines : []), ...missing]
    recovered.push('customEngines')
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const key of SNAPSHOT_FIELDS) {
    const saved = source[key]
    if (saved === undefined || saved === null) continue
    if (same(current[key], saved)) continue
    // Only a value that is still the default counts as "lost"; anything else
    // was set on purpose and is left alone.
    if (!same(current[key], defaults[key])) continue
    out[key] = saved
    recovered.push(key)
  }

  return { config: out, recovered }
}
