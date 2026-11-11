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
 * Two rules keep a save honest:
 *
 *  - Nothing is written when validation rejects part of the patch. A row that
 *    fails (bad id, bad URL, duplicate) is named in the 400 response instead of
 *    being silently dropped, because "保存成功" followed by a missing engine
 *    after the next restart is indistinguishable from data loss.
 *  - A successful save also refreshes the durable snapshot (`lib/store.js`).
 *    The profile patch can be renamed away by the desktop recovery flow; the
 *    snapshot is what lets the plugin restore the engines at the next load.
 *
 * Dependencies are injected rather than imported from `./index.js`, because a
 * host/client circular import would hand this module a half-initialized
 * `resolveConfig`.
 */
import { validateCustomEngines } from './backends.js'

export const ROUTE = '/plugins/dsh-search-fusion'

/** Profile entry id; also the namespace the host serves this plugin under. */
export const SETTINGS_NS = 'dsh-search-fusion'

const BUILTINS = ['bing', 'ddg', 'ddg-lite', 'searxng']

/** Fields the settings page may edit, in the order they are validated. */
const NUMERIC_FIELDS = ['maxResults', 'minResults', 'cacheTtlMs', 'engineTimeoutMs']

/** Human labels for the fields a recovery may restore (page banner). */
const FIELD_LABELS = {
  primary: '主引擎',
  fallback: '回退链',
  strategy: '策略',
  maxResults: '结果数',
  minResults: '融合阈值',
  cacheEnabled: '缓存开关',
  cacheTtlMs: '缓存时长',
  engineTimeoutMs: '引擎超时',
  locale: '搜索语言',
  proxy: '代理',
  searxngInstances: 'SearXNG 实例',
  engineWeights: '引擎权重',
  customEngines: '自定义搜索引擎',
}

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
 * Validate a save patch before anything is written.
 *
 * Returns user-facing reasons. An empty list means every value in the patch is
 * exactly what the host will persist — which is the property the page promises
 * when it says 已保存.
 *
 * @param patch - incoming patch (secrets already stripped or harmless).
 * @param resolved - result of {@link applyEngineSettings}.
 * @returns `{ errors, engines }`, engines being the normalized engine rows.
 */
export function validatePatch(patch, resolved) {
  const errors = []
  let engines = Array.isArray(resolved?.customEngines) ? resolved.customEngines : []

  if (patch.customEngines !== undefined) {
    const checked = validateCustomEngines(patch.customEngines)
    errors.push(...checked.errors)
    engines = checked.engines
  }

  const knownIds = new Set([...BUILTINS, ...engines.map((engine) => engine.id)])
  if (patch.primary !== undefined && !knownIds.has(patch.primary)) {
    errors.push(`主引擎 "${patch.primary}" 不可用：它既不是内置引擎，也不在当前的自定义引擎列表里`)
  }
  if (patch.fallback !== undefined) {
    if (!Array.isArray(patch.fallback)) {
      errors.push('回退链必须是数组')
    } else {
      for (const id of patch.fallback) {
        if (!knownIds.has(id)) errors.push(`回退链里的 "${id}" 不可用：它既不是内置引擎，也不在当前的自定义引擎列表里`)
      }
    }
  }
  for (const key of NUMERIC_FIELDS) {
    const wanted = patch[key]
    if (wanted === undefined) continue
    if (typeof wanted !== 'number' || !Number.isSafeInteger(wanted) || wanted <= 0) {
      errors.push(`${key} 必须是正整数（收到 ${JSON.stringify(wanted)}）`)
    } else if (resolved[key] !== wanted) {
      errors.push(`${key} 超出允许范围：${wanted} 会被写成 ${resolved[key]}，请改成范围内的值`)
    }
  }
  if (patch.strategy !== undefined && resolved.strategy !== patch.strategy) {
    errors.push(`策略 "${patch.strategy}" 无效；可选 sequential / fusion / always-fuse`)
  }
  return { errors, engines }
}

/**
 * Attach the recovery state to a snapshot payload.
 *
 * `store` tells the page where the durable copy lives, `recovered` lists what
 * the previous load had to restore from it — the page turns that into a banner
 * telling the user their profile config had been cleared by something else.
 */
function recoveryInfo(store, recovered) {
  const info = {
    path: store?.path ?? '',
    savedAt: store?.savedAt ?? '',
    recovered: Array.isArray(recovered) ? recovered : [],
  }
  info.recoveredLabels = info.recovered.map((key) => FIELD_LABELS[key] ?? key)
  return info
}

/** @param ctx - context already inside the `webServer` injection. */
export function registerConfigRoutes(ctx, api) {
  const { webServer } = ctx
  if (webServer === undefined || typeof webServer.register !== 'function') return []
  const {
    getCurrent, replaceCurrent, resolveConfig, normalizeCustomEngines,
    presets = [], store, recovered = [], log = () => {},
  } = api

  /** One-shot: write a restored config back into the profile patch. */
  let healAttempted = false
  const healProfile = async () => {
    if (healAttempted || recovered.length === 0) return
    healAttempted = true
    const settings = ctx.get?.('settings')
    if (settings === undefined || typeof settings.update !== 'function') return
    try {
      const current = getCurrent()
      await settings.update(SETTINGS_NS, project(current))
      store?.save?.(current)
      log('info', `dsh-search-fusion: wrote the recovered settings back to the profile patch (${recovered.join(', ')})`)
    } catch (error) {
      // Read-only profile or a host without writable settings: the snapshot
      // keeps serving the recovered config, so this is a warning, not a failure.
      log('warn', `dsh-search-fusion: could not write the recovered settings back: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const snapshot = async () => {
    const current = getCurrent()
    const credentials = ctx.get?.('credentials')
    const keys = await describeEngineKeys(credentials, current.customEngines)
    const saved = store?.read?.()
    return {
      config: project(current),
      engines: [...BUILTINS, ...current.customEngines.map((d) => d.id)],
      builtins: BUILTINS,
      presets,
      keys,
      /** Whether a pasted key can be stored at all (no service => ref-name only). */
      canStoreKeys: credentials !== undefined && typeof credentials.set === 'function',
      namespace: SETTINGS_NS,
      /** Durable snapshot + recovery state (see lib/store.js). */
      store: recoveryInfo({ path: store?.path, savedAt: saved?.savedAt ?? '' }, recovered),
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
  const storeSecrets = async (patch, engines) => {
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

    const rows = Array.isArray(engines) ? engines : getCurrent().customEngines
    const credentials = ctx.get?.('credentials')

    // Give every engine that is about to receive a key a reference to store it under.
    const resolvedEngines = rows.map((engine) => {
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
      // A secret for an engine that is not part of this save is a bug in the
      // page, not a reason to invent a credential entry nobody reads.
      if (ref === '' || engine === undefined) continue
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

      if (req.method === 'GET') {
        // Lazy repair: the profile entry was loaded before the plugin could
        // write, so a recovered config is re-persisted on the first page read
        // (the moment the user opens Settings). Never blocks the response.
        await healProfile()
        return sendJson(res, 200, { ok: true, value: await snapshot() })
      }
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

        // Validate BEFORE storing secrets or touching the file: a rejected save
        // must leave both the credentials and the profile exactly as they were.
        const preview = applyEngineSettings({ resolveConfig, normalizeCustomEngines }, getCurrent(), incoming)
        const checked = validatePatch(incoming, preview)
        if (checked.errors.length > 0) {
          return sendJson(res, 400, {
            ok: false,
            error: '保存被拒绝：配置里有无法写入的项',
            details: checked.errors,
          })
        }

        const { patch } = await storeSecrets(incoming, checked.engines)
        const resolved = applyEngineSettings({ resolveConfig, normalizeCustomEngines }, getCurrent(), patch)
        await settings.update(SETTINGS_NS, project(resolved))
        // The profile patch is the host's source of truth, the snapshot is the
        // recovery copy. Both are written before the page reports success.
        const stored = store?.save?.(resolved) === true
        replaceCurrent(resolved)
        // The page now shows exactly what the profile holds; there is nothing
        // left for the recovery banner to advertise.
        recovered.length = 0
        return sendJson(res, 200, { ok: true, value: { ...(await snapshot()), persisted: stored } })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })]
}
