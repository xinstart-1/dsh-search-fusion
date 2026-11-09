/**
 * dsh-search-fusion — host half of the settings routes.
 *
 * The browser half (`lib/client.js`) owns the settings page; this module gives
 * it two endpoints under `/plugins/dsh-search-fusion`:
 *
 *   GET  /config   effective config + engine catalog
 *   POST /config   merge a patch into this plugin's profile entry config
 *
 * Writes go through the host settings service (`settings.update(ns, patch)`),
 * whose namespace is the profile entry id. If that service is missing the
 * handler answers with a clear error instead of throwing — a thrown handler
 * would blank the settings page.
 *
 * Dependencies are injected rather than imported from `./index.js`, because a
 * host/client circular import would hand this module a half-initialized
 * `resolveConfig`.
 */

export const ROUTE = '/plugins/dsh-search-fusion'

/** Profile entry id; also the namespace the host serves this plugin under. */
export const SETTINGS_NS = 'dsh-search-fusion'

const BUILTINS = ['bing', 'ddg', 'ddg-lite', 'searxng', 'anysearch']

/**
 * Derive a legal credential reference (POSIX shell identifier) for an engine
 * whose row has no explicit `apiKeyEnv`. The settings page can then save a pasted
 * key without asking the user to invent a variable name.
 */
export function defaultKeyRef(engineId) {
  const name = String(engineId ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return name === '' ? '' : `DSH_SEARCH_${name}_KEY`
}

function sendJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** Only the loopback browser that serves the GUI may read or write config. */
export function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Read a JSON body with a hard size cap. */
async function readJson(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(Buffer.from(chunk))
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Fields the settings page may edit (never a secret value, only its ref). */
function project(config) {
  return {
    primary: config.primary,
    fallback: config.fallback,
    strategy: config.strategy,
    maxResults: config.maxResults,
    minResults: config.minResults,
    cacheEnabled: config.cacheEnabled,
    cacheTtlMs: config.cacheTtlMs,
    engineTimeoutMs: config.engineTimeoutMs,
    locale: config.locale,
    proxy: config.proxy,
    searxngInstances: config.searxngInstances,
    anysearchApiKeyEnv: config.anysearchApiKeyEnv,
    customEngines: config.customEngines,
  }
}

/**
 * Write the "value already present" flags for the engine credential refs.
 *
 * The page never receives a secret, only whether one is configured, so it can
 * show "已配置" instead of a fake placeholder that would look like a stored key.
 */
async function describeEngineKeys(credentials, engines) {
  const out = {}
  for (const engine of engines) {
    const ref = engine?.apiKeyEnv
    if (typeof ref !== 'string' || ref === '') continue
    try {
      const described = await credentials.describe(ref)
      out[engine.id] = { ref, configured: described?.configured === true }
    } catch {
      out[engine.id] = { ref, configured: false }
    }
  }
  return out
}

/**
 * Merge one settings-page patch into the live config.
 *
 * Kept here (not in index.js) so every rule that touches a secret lives in the
 * same module, and so the offline route tests can drive it without a host.
 *
 * @param api - `{ resolveConfig, normalizeCustomEngines }`
 */
export function applyEngineSettings({ resolveConfig, normalizeCustomEngines }, current, patch) {
  const merged = { ...current, ...patch }
  // Normalize here so an invalid draft never reaches the profile file.
  if (patch.customEngines !== undefined) merged.customEngines = normalizeCustomEngines(patch.customEngines)
  return resolveConfig(merged)
}

/**
 * @param ctx - context already inside the `webServer` injection.
 * @param api - `{ getCurrent, replaceCurrent, resolveConfig, normalizeCustomEngines, presets? }`
 * @returns disposers (the caller registers them as Cordis effects)
 */
export function registerConfigRoutes(ctx, api) {
  const { webServer } = ctx
  if (webServer === undefined || typeof webServer.register !== 'function') return []
  const { getCurrent, replaceCurrent, resolveConfig, normalizeCustomEngines, presets = [] } = api
  const normalize = normalizeCustomEngines

  const snapshot = async () => {
    const current = getCurrent()
    const credentials = ctx.get?.('credentials')
    const keys = await describeEngineKeys(credentials, current.customEngines)
    return {
      config: project(current),
      engines: [...BUILTINS, ...current.customEngines.map((d) => d.id)],
      builtins: BUILTINS,
      presets,
      keys,
      /** Whether a pasted key can be stored at all (no service => ref-name only). */
      canStoreKeys: credentials !== undefined && typeof credentials.set === 'function',
      namespace: SETTINGS_NS,
    }
  }

  /**
   * Persist the secrets the page staged, then drop them from the patch.
   *
   * The page sends `secrets: { <engine id>: '<pasted key>' }`; each key is stored
   * under that engine's credential ref (an explicit `apiKeyEnv`, else a derived
   * `DSH_SEARCH_<ID>_KEY`). Secrets never reach the profile file, and the patch
   * that does get written carries only the reference name.
   */
  const storeSecrets = async (patch) => {
    const secrets = patch?.secrets
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) return { patch, wrote: 0 }
    const { secrets: _dropped, ...rest } = patch

    // Ids are case-insensitive everywhere else (normalizeCustomEngine lowercases
    // them), so key them lowercase here too — otherwise a row saved as `Tavily`
    // would get its secret under a ref the engine never reads.
    const wanted = new Map()
    for (const [id, value] of Object.entries(secrets)) {
      if (typeof value !== 'string' || value.trim() === '') continue
      wanted.set(String(id).toLowerCase(), value.trim())
    }
    if (wanted.size === 0) return { patch: rest, wrote: 0 }

    const engines = Array.isArray(patch.customEngines) ? patch.customEngines : getCurrent().customEngines
    const credentials = ctx.get?.('credentials')

    // Give every engine that is about to receive a key a reference to store it under.
    const resolvedEngines = engines.map((engine) => {
      const id = String(engine?.id ?? '').toLowerCase()
      if (!wanted.has(id)) return engine
      const existing = typeof engine?.apiKeyEnv === 'string' ? engine.apiKeyEnv.trim() : ''
      return existing !== '' ? engine : { ...engine, apiKeyEnv: defaultKeyRef(id) }
    })

    let wrote = 0
    for (const [id, value] of wanted) {
      const engine = resolvedEngines.find((row) => String(row?.id ?? '').toLowerCase() === id)
      const ref = typeof engine?.apiKeyEnv === 'string' && engine.apiKeyEnv.trim() !== ''
        ? engine.apiKeyEnv.trim()
        : defaultKeyRef(id)
      if (ref === '') continue
      if (credentials === undefined || typeof credentials.set !== 'function') {
        throw new Error(`cannot store a key for "${id}": the credentials service is unavailable; set ${ref} in the environment instead`)
      }
      await credentials.set(ref, value)
      wrote += 1
    }
    return { patch: { ...rest, ...(wrote > 0 ? { customEngines: resolvedEngines } : {}) }, wrote }
  }

  return [webServer.register({
    kind: 'exact',
    path: `${ROUTE}/config`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })

      if (req.method === 'GET') return sendJson(res, 200, { ok: true, value: await snapshot() })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })

      let body
      try {
        body = await readJson(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: `invalid body: ${error instanceof Error ? error.message : String(error)}` })
      }

      const incoming = body?.patch ?? body
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return sendJson(res, 400, { ok: false, error: 'patch must be an object' })
      }

      try {
        const settings = ctx.get?.('settings')
        if (settings === undefined || typeof settings.update !== 'function') {
          return sendJson(res, 503, {
            ok: false,
            error: 'settings service unavailable; edit the profile cordis.patch.yml instead (see README)',
          })
        }

        const { patch } = await storeSecrets(incoming)
        const resolved = applyEngineSettings({ resolveConfig, normalizeCustomEngines: normalize }, getCurrent(), patch)
        await settings.update(SETTINGS_NS, project(resolved))
        replaceCurrent(resolved)
        return sendJson(res, 200, { ok: true, value: await snapshot() })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })]
}
