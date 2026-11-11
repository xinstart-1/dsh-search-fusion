/**
 * dsh-search-fusion — multi-engine web search for DeepSeek Harness.
 *
 * Registers exactly ONE search provider (`fusion`) into `ctx.web`. The provider
 * owns backend selection, fallback and result fusion internally, because
 * `ctx.web` resolves a provider per call and offers no dynamic switching seam.
 */
import {
  BACKEND_IDS, backendIds, isBackendId,
  installCustomEngines, normalizeCustomEngines,
  ENGINE_PRESETS, findPreset,
} from './backends.js'
import { SearchCache } from './cache.js'
import { createProxyFetch } from './proxy.js'
import { registerConfigRoutes } from './routes.js'
import { mergeRecoveredConfig, readSnapshot, resolveStatePath, writeSnapshot } from './store.js'
import { FusionProvider, PROVIDER_ID, STRATEGIES } from './provider.js'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'dsh-search-fusion'

/** Capability seams consumed by this plugin. */
export const inject = ['web']

const SETTINGS_NS = 'search-fusion'

// link: resolves from the plugin realpath, outside the host dependency tree.
// Only the optional settings UI needs schemastery; failure must not block loading.
//
// IMPORTANT (DSH 0.2.1-rc.5): the host generates a settings card by reading
// this exported `Config` and calling `volatileForm(schema)` — it keeps ONLY
// fields marked `.volatile()`. Without them the card silently never appears.
// The card's namespace is the profile entry id (`dsh-search-fusion`), and the
// host also validates `entry.config` against this schema at load time, so the
// schema must stay permissive (strings, optional fields, no hardcoded engine
// union) — business validation lives in resolveConfig()/normalizeCustomEngines().
let schemaError
export let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')
  const v = (schema) => schema.volatile()
  Config = z.object({
    /** Engine asked first; may be a built-in or a user-defined custom id. */
    primary: v(z.string().default('bing')),
    /** Engines tried after the primary fails or underdelivers. */
    fallback: v(z.array(z.string()).default(['ddg', 'searxng'])),
    /** sequential / fusion / always-fuse. */
    strategy: v(z.union(STRATEGIES).default('fusion')),
    maxResults: v(z.number().step(1).min(1).max(50).default(10)),
    minResults: v(z.number().step(1).min(1).max(50).default(5)),
    cacheEnabled: v(z.boolean().default(true)),
    cacheTtlMs: v(z.number().step(1).min(1).default(600000)),
    engineTimeoutMs: v(z.number().step(1).min(1000).default(12000)),
    locale: v(z.string().default('zh-CN')),
    proxy: v(z.string().default('')),
    searxngInstances: v(z.array(z.string()).default([])),
    engineWeights: v(z.dict(z.number()).default({})),
    /**
     * User-defined JSON search engines. Every field is optional and volatile so
     * the settings page can add/edit/remove rows without rejecting a half-filled
     * draft. See README "自定义搜索引擎".
     */
    // Only the OUTER array is volatile. The host's validator rejects volatile
    // fields inside an array ("volatile fields require a fixed object path
    // without an enclosing volatile field"), and volatileForm() already keeps
    // the whole subtree when the array itself is volatile.
    customEngines: v(z.array(z.object({
      id: z.string().default(''),
      label: z.string().default(''),
      preset: z.string().default('custom'),
      transport: z.string().default('rest'),
      url: z.string().default(''),
      method: z.string().default('GET'),
      apiKeyEnv: z.string().default(''),
      authHeader: z.string().default('Authorization: Bearer {key}'),
      resultsPath: z.string().default('results'),
      urlField: z.string().default('url'),
      titleField: z.string().default('title'),
      snippetField: z.string().default('snippet'),
      bodyTemplate: z.string().default('{"query":"{query}","max_results":{maxResults}}'),
      mcpTool: z.string().default(''),
      mcpQueryArg: z.string().default('query'),
      mcpMaxResultsArg: z.string().default('max_results'),
    })).default([])),
  })
} catch (error) {
  schemaError = error
}

/** Resolve defaults and reject self-contained configuration errors before registering. */
export function resolveConfig(config) {
  // A valid id is either a registered adapter or one this same config declares
  // as a custom engine. The second half matters: the settings page can write
  // `primary: <custom id>` in the same save that introduces the engine, and
  // resolveConfig() may run before installCustomEngines() has registered it.
  const customEngines = normalizeCustomEngines(config?.customEngines)
  if ((config?.primary === 'anysearch' || (Array.isArray(config?.fallback) && config.fallback.includes('anysearch')))
    && !customEngines.some((def) => def.id === 'anysearch')) {
    // Existing profiles selected the former built-in; retain that selection as a preset row.
    customEngines.unshift(normalizeCustomEngines([{ ...findPreset('anysearch'), preset: 'anysearch' }])[0])
  }
  const declared = new Set(customEngines.map((def) => def.id))
  const usable = (id) => isBackendId(id) || declared.has(id)

  return {
    primary: usable(config?.primary) ? config.primary : 'bing',
    fallback: Array.isArray(config?.fallback) ? config.fallback.filter(usable) : ['ddg', 'searxng'],
    strategy: STRATEGIES.includes(config?.strategy) ? config.strategy : 'fusion',
    maxResults: positiveInt(config?.maxResults, 10),
    minResults: positiveInt(config?.minResults, 5),
    cacheEnabled: config?.cacheEnabled !== false,
    cacheTtlMs: positiveInt(config?.cacheTtlMs, 600_000),
    engineTimeoutMs: positiveInt(config?.engineTimeoutMs, 12_000),
    locale: typeof config?.locale === 'string' && config.locale.trim().length > 0 ? config.locale.trim() : 'zh-CN',
    proxy: typeof config?.proxy === 'string' ? config.proxy.trim() : '',
    searxngInstances: Array.isArray(config?.searxngInstances)
      ? config.searxngInstances.filter((item) => typeof item === 'string' && item.length > 0)
      : [],
    engineWeights: isNumberDict(config?.engineWeights) ? config.engineWeights : {},
    customEngines,
  }
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function isNumberDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'number')
}

/** Register the fusion provider, its model-facing tools and the settings surface. */
export function apply(ctx, config) {
  // Durable recovery copy (see lib/store.js). The profile patch is the host's
  // source of truth, but the desktop recovery flow can rename it away; when
  // that (or a regenerated profile) drops the user's engines, the snapshot put
  // them back so a restart no longer silently resets the settings page.
  const statePath = resolveStatePath(ctx)
  const savedSnapshot = readSnapshot(statePath)
  let recovered = []
  const defaults = resolveConfig({})
  let initial = resolveConfig(config ?? {})
  if (savedSnapshot !== undefined) {
    const merged = mergeRecoveredConfig({ current: initial, snapshot: savedSnapshot, defaults })
    if (merged.recovered.length > 0) {
      initial = resolveConfig(merged.config)
      recovered = merged.recovered
      log(ctx, 'warn',
        `dsh-search-fusion: the profile config lost [${recovered.join(', ')}]; restored from ${statePath}. `
        + 'Open Settings -> 搜索融合 and press 保存 to write it back into the profile patch.',
      )
    }
  }

  // Install user-defined engines first so resolveConfig()'s isBackendId() checks
  // accept their ids in primary/fallback. The disposer is returned to Cordis.
  const removeCustomEngines = installCustomEngines(initial.customEngines)
  let current = initial

  const state = { report: null }
  const cache = new SearchCache({ ttlMs: current.cacheTtlMs })

  /** Resolve one credential reference through the host, then env fallbacks. */
  const resolveRef = async (ref) => {
    const sources = [
      async () => (await ctx.get('credentials')?.resolve(ref))?.value,
      () => ctx.get('launchEnvironment')?.get(ref)?.value,
      () => process.env[ref],
    ]
    for (const read of sources) {
      try {
        const value = await read()
        if (typeof value === 'string' && value.length > 0) return value
      } catch (error) {
        log(ctx, 'warn', `dsh-search-fusion: credential resolve failed for "${ref}": ${error?.message ?? error}`)
      }
    }
    return ''
  }

  /**
   * Credentials are references resolved on demand: one resolve per search, so a
   * rotated key is picked up without restarting the plugin. Each custom engine
   * gets its own key, keyed by engine id (provider.js passes apiKey per engine).
   */
  const resolveCredentials = async () => {
    const out = {}
    for (const def of current.customEngines) {
      if (def.apiKeyEnv === '') continue
      const value = await resolveRef(def.apiKeyEnv)
      if (value !== '') out[def.id] = value
    }
    return out
  }

  let credentials = {}
  const refreshCredentials = async () => {
    credentials = await resolveCredentials()
    return credentials
  }

  /**
   * Build the `fetch` used for engine calls. Rebuilt only when the proxy setting
   * changes, because constructing the tunnel client is cheap but pointless to do
   * on every search.
   */
  let proxyCache = { url: null, fn: null }
  const engineFetch = () => {
    const url = current.proxy
    if (url === '') return undefined
    if (proxyCache.url === url) return proxyCache.fn
    try {
      proxyCache = { url, fn: createProxyFetch(url) }
      return proxyCache.fn
    } catch (error) {
      log(ctx, 'warn', `dsh-search-fusion: cannot use proxy "${url}": ${error instanceof Error ? error.message : String(error)}`)
      proxyCache = { url, fn: undefined }
      return undefined
    }
  }

  // Refresh once per search. Missing/failed credential services fall back to
  // launch environment and process.env; free engines need no key.
  const provider = new FusionProvider({
    config: () => ({ ...current, credentials, proxyFetch: engineFetch() }),
    prepare: refreshCredentials,
    cache,
    get report() {
      return state.report
    },
    set report(value) {
      state.report = value
    },
  })

  ctx.web.registerSearchProvider(provider)

  // Diagnose the loader-patch trap this bundle's own cordis.patch.yml has to
  // work around: a patch replaces the web row's whole `config`, so a layer that
  // sets `searchProvider` without restating `fetchProvider` drops the host
  // default and every web_fetch fails with WEB_PROVIDER_AMBIGUOUS. Warn once at
  // load instead of letting it surface as a confusing fetch error.
  try {
    const fetchRef = ctx.web.config?.fetchProvider
    if (typeof fetchRef?.get === 'function' && fetchRef.get() === undefined) {
      log(ctx, 'warn', 'dsh-search-fusion: web.fetchProvider is unset; web_fetch fails with WEB_PROVIDER_AMBIGUOUS as soon as two fetch providers are usable. Set fetchProvider ("http" or "deepseek-fetch-api") in the profile cordis.patch.yml.')
    }
  } catch {
    // Host without a readable web config ref: nothing to check.
  }

  const toolApi = {
    getConfig: () => current,
    setConfig: (next) => {
      current = next
      cache.clear()
    },
    cache,
    getReport: () => state.report,
  }

  optionalInject(ctx, 'tools', (toolCtx) => registerFusionTools(toolCtx, toolApi))

  // The settings CARD is generated by the host from the exported `Config`
  // (volatile fields) — NOT by calling anything here. DSH 0.2.1-rc.5 has no
  // `settings.register`/`installSection` runtime API (verified in app.asar).
  // Keep a best-effort live watch only for hosts that happen to expose one;
  // the durable path is: save in Settings -> value written to the profile patch
  // -> restart rebuilds the plugin instance with the new config.
  if (Config === undefined) {
    log(ctx, 'warn', `dsh-search-fusion: schemastery unavailable; settings schema skipped: ${schemaError?.message ?? 'unknown error'}`)
  } else {
    optionalInject(ctx, 'settings', (sctx) => {
      const settings = sctx.settings
      if (typeof settings?.register !== 'function') return undefined
      try {
        const scope = settings.register(SETTINGS_NS, Config, { base: current })
        if (scope === undefined || typeof scope.get !== 'function') return undefined
        current = resolveConfig({ ...current, ...scope.get() })
        cache.clear()
        if (typeof scope.watch === 'function') {
          return scope.watch(() => {
            try {
              current = resolveConfig({ ...current, ...scope.get() })
              cache.clear()
            } catch (error) { log(ctx, 'warn', `dsh-search-fusion: settings update failed: ${error}`) }
          })
        }
      } catch (error) {
        log(ctx, 'warn', `dsh-search-fusion: optional settings watch unavailable: ${error}`)
      }
      return undefined
    })
  }

  // Settings page data (the browser half calls these over HTTP). Registered on
  // the host web server so the page can read and persist without a Remote API.
  optionalInject(ctx, 'webServer', (serverCtx) => {
    // Engines added/edited in the settings page must work on the next search,
    // without a restart: saving swaps the adapter registry to match the new
    // config. `reinstallEngines` replaces what this instance owns; the previous
    // adapters for ids that disappeared are dropped at the same time.
    let disposeEngines = removeCustomEngines
    const reinstallEngines = (nextConfig) => {
      try { disposeEngines() } catch { /* previous registry already gone */ }
      disposeEngines = installCustomEngines(nextConfig?.customEngines)
    }

    const disposers = registerConfigRoutes(serverCtx, {
      getCurrent: () => current,
      replaceCurrent: (next) => {
        current = next
        cache.clear()
        reinstallEngines(next)
        // The page saved what it shows, so the "restored from snapshot" banner
        // must not keep advertising a recovery state that no longer applies.
        recovered.length = 0
      },
      resolveConfig,
      normalizeCustomEngines,
      presets: ENGINE_PRESETS,
      recovered,
      store: {
        path: statePath,
        read: () => readSnapshot(statePath),
        save: (next) => writeSnapshot(statePath, next),
      },
      log: (level, message) => log(ctx, level, message),
    })
    return () => {
      for (const dispose of disposers) {
        try { if (typeof dispose === 'function') dispose() } catch { /* already gone */ }
      }
      try { disposeEngines() } catch { /* registry already torn down */ }
    }
  })

  log(ctx, 'info',
    `dsh-search-fusion: provider "${PROVIDER_ID}", strategy "${current.strategy}", `
    + `chain [${[current.primary, ...current.fallback].join(' -> ')}], `
    + `custom engines [${current.customEngines.map((d) => d.id).join(', ') || 'none'}]`,
  )

  // Called on plugin disposal: drop the ids this instance contributed.
  return () => {
    try { removeCustomEngines() } catch { /* registry already torn down */ }
  }
}

/* ------------------------------------------------------------------ */
/* Model-facing tools                                                  */
/* ------------------------------------------------------------------ */

function registerFusionTools(ctx, api) {
  const statusTool = {
    name: 'search_fusion_status',
    description:
      'Show the search-fusion configuration (primary engine, fallback chain, strategy), '
      + 'the engines available, cache statistics and the last search outcome.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput,
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute() {
      const config = api.getConfig()
      const report = api.getReport()
      const lines = [
        `primary engine: ${config.primary}`,
        `fallback chain: ${config.fallback.length === 0 ? '(none)' : config.fallback.join(' -> ')}`,
        `strategy: ${config.strategy}`,
        `available engines: ${backendIds().join(', ')}`,
        `custom engines: ${config.customEngines.length === 0 ? 'none' : config.customEngines.map((d) => `${d.id} (${d.transport === 'mcp' ? `MCP ${d.url}` : `${d.method} ${d.url}`}${d.apiKeyEnv ? ', key: ' + d.apiKeyEnv : ', no key'})`).join('; ')}`,
        `max results: ${config.maxResults} (fusion triggers below ${config.minResults})`,
        `cache: ${config.cacheEnabled ? 'enabled' : 'disabled'}, ttl ${config.cacheTtlMs} ms, `
          + `${api.cache.stats().size} entries, ${api.cache.stats().hits} hits / ${api.cache.stats().misses} misses`,
        `last search: ${report === null ? 'none yet' : `${report.at} engines=[${report.engines.join(', ')}]${report.cached ? ' (cached)' : ''}${report.error === null ? '' : ` error=${report.error}`}`}`,
      ]
      return lines.join('\n')
    },
  }

  const switchTool = {
    name: 'search_fusion_switch',
    description:
      'Switch the primary search engine and/or the fallback chain used by web_search. '
      + 'Takes effect on the next search; no restart needed.',
    output: textOutput,
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        primary: { type: 'string', description: `Primary engine id; available now: ${backendIds().join(', ')}` },
        fallback: {
          type: 'array',
          items: { type: 'string' },
          description: 'Engines to try, in order, when the primary fails or underdelivers.',
        },
      },
    },
    async execute(args = {}) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
      if (args.fallback !== undefined && !Array.isArray(args.fallback)) throw new Error('fallback must be an array')
      const config = api.getConfig()
      if (args.primary !== undefined && !isBackendId(args.primary)) {
        throw new Error(`unknown engine "${args.primary}"; available: ${backendIds().join(', ')}`)
      }
      const unknown = (args.fallback ?? []).filter((id) => !isBackendId(id))
      if (unknown.length > 0) {
        throw new Error(`unknown engine(s) in fallback: ${unknown.join(', ')}; available: ${backendIds().join(', ')}`)
      }
      const next = {
        ...config,
        ...args.primary === undefined ? {} : { primary: args.primary },
        ...args.fallback === undefined ? {} : { fallback: args.fallback.filter((id) => id !== (args.primary ?? config.primary)) },
      }
      api.setConfig(next)
      return `search fusion updated: primary "${next.primary}", fallback [${next.fallback.join(' -> ')}]. The next web_search uses it immediately.`
    },
  }

  const disposers = []
  for (const tool of [statusTool, switchTool]) {
    try { disposers.push(ctx.tools.register(tool)) }
    catch (error) { log(ctx, 'warn', `dsh-search-fusion: tool registration failed: ${error}`) }
  }
  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* already disposed */ }
    }
  }
}

// Compiled tool definitions: do not import dsh-tools from a link: directory.
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function log(ctx, level, message) {
  try { ctx.logger?.[level]?.(message) } catch { /* optional host service */ }
}

function optionalInject(ctx, service, register) {
  try {
    const bind = (scope) => {
      const setup = () => {
        try { return register(scope) }
        catch (error) { log(ctx, 'warn', `dsh-search-fusion: ${service} unavailable: ${error}`) }
      }
      try {
        if (typeof scope.effect === 'function') return scope.effect(setup)
        return setup()
      } catch (error) { log(ctx, 'warn', `dsh-search-fusion: ${service} binding failed: ${error}`) }
    }
    if (typeof ctx.inject === 'function') ctx.inject([service], bind)
    else return bind(ctx)
  } catch (error) { log(ctx, 'warn', `dsh-search-fusion: ${service} injection failed: ${error}`) }
}
