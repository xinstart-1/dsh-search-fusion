/**
 * dsh-search-fusion — multi-engine web search for DeepSeek Harness.
 *
 * Registers exactly ONE search provider (`fusion`) into `ctx.web`. The provider
 * owns backend selection, fallback and result fusion internally, because
 * `ctx.web` resolves a provider per call and offers no dynamic switching seam.
 */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ADAPTERS, BACKEND_IDS, isBackendId } from './backends.js'
import { SearchCache } from './cache.js'
import { createProxyFetch } from './proxy.js'
import { FusionProvider, PROVIDER_ID, STRATEGIES } from './provider.js'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'web-search-fusion'

/** Capability seams consumed by this plugin. */
export const inject = ['web', 'tools', 'credentials']

const SETTINGS_NS = 'search-fusion'

/** Credential reference (env-var name) defaults per engine that needs one. */
const DEFAULT_CREDENTIAL_ENVS = {
  anysearch: 'ANYSEARCH_API_KEY',
}

export const Config = z.object({
  /**
   * The engine asked first. Everything else is only paid for when it fails,
   * comes back empty, or comes back thin (see `strategy`).
   */
  primary: z.union(BACKEND_IDS).default('bing'),
  /** Engines tried in order after the primary fails or underdelivers. */
  fallback: z.array(z.union(BACKEND_IDS)).default(['ddg', 'searxng']),
  /**
   * `sequential` — one engine at a time until one answers (cheapest).
   * `fusion`     — same walk, but keep going when the answer is thin (default).
   * `always-fuse`— query every engine in the chain, merge all of them.
   */
  strategy: z.union(STRATEGIES).default('fusion'),
  /** How many sources the fused result keeps. */
  maxResults: z.number().step(1).min(1).max(50).default(10),
  /** `fusion` strategy: below this many results, the next engine is queried too. */
  minResults: z.number().step(1).min(1).max(50).default(5),
  /** Query cache: repeat identical searches cost nothing while it lives. */
  cacheEnabled: z.boolean().default(true),
  cacheTtlMs: z.number().step(1).min(1).default(600000),
  /** Per-engine request budget; a hanging engine cannot stall the whole search. */
  engineTimeoutMs: z.number().step(1).min(1000).default(12000),
  /** Search locale / market hint passed to engines that support it. */
  locale: z.string().default('zh-CN'),
  /**
   * HTTP proxy for engines that are unreachable directly (mainland China needs
   * one for DuckDuckGo / SearXNG). Empty means connect directly. Node's global
   * fetch ignores HTTPS_PROXY, so the plugin ships its own tunnel client.
   */
  proxy: z.string().default(''),
  /** Public SearXNG instances tried in order, only when that backend is used. */
  searxngInstances: z.array(z.string()).default([]),
  /**
   * Per-engine credential *references* (env-var names), never values. Resolved
   * on each search so a rotated key reaches the next request without a restart.
   */
  anysearchApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_CREDENTIAL_ENVS.anysearch),
  /** Manual weight tweak for ranking; unset engines weigh 1. */
  engineWeights: z.dict(z.number()).default({}),
})

/** Resolve defaults and reject self-contained configuration errors before registering. */
export function resolveConfig(config) {
  const anysearchRef = typeof config?.anysearchApiKeyEnv === 'string' && config.anysearchApiKeyEnv.trim().length > 0
    ? config.anysearchApiKeyEnv.trim()
    : DEFAULT_CREDENTIAL_ENVS.anysearch
  return {
    primary: isBackendId(config?.primary) ? config.primary : 'bing',
    fallback: Array.isArray(config?.fallback) ? config.fallback.filter(isBackendId) : ['ddg', 'searxng'],
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
    anysearchApiKeyEnv: anysearchRef,
    credentialRef: credentialRef(anysearchRef),
    engineWeights: isNumberDict(config?.engineWeights) ? config.engineWeights : {},
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
  let current = resolveConfig(config ?? {})

  const state = { report: null }
  const cache = new SearchCache({ ttlMs: current.cacheTtlMs })

  /**
   * Credentials are references resolved on demand: one resolve per search, so a
   * rotated key is picked up without restarting the plugin.
   */
  const resolveCredentials = async () => {
    const out = {}
    try {
      const value = await ctx.credentials.resolve(current.credentialRef)
      if (value !== undefined && value !== null && typeof value.value === 'string' && value.value.length > 0) {
        out.anysearch = value.value
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-search-fusion: credential resolve failed: ${error instanceof Error ? error.message : String(error)}`)
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
      ctx.logger?.warn?.(`dsh-search-fusion: cannot use proxy "${url}": ${error instanceof Error ? error.message : String(error)}`)
      proxyCache = { url, fn: undefined }
      return undefined
    }
  }

  // The provider asks for a fresh credential snapshot, but a slow/absent
  // credential service must not block search: the previous snapshot (often empty)
  // is good enough for the free engines.
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

  registerFusionTools(ctx, {
    getConfig: () => current,
    setConfig: (next) => {
      current = next
      cache.clear()
    },
    cache,
    getReport: () => state.report,
    refreshCredentials,
  })

  // Settings panel (Settings > Plugins > Search fusion). Optional: the plugin
  // stays functional when the settings service is absent.
  ctx.inject(['settings'], (sctx) => {
    if (sctx?.settings === undefined || typeof sctx.settings.installSection !== 'function') {
      ctx.logger?.warn?.('[dsh-search-fusion] settings service unavailable: installSection missing')
      return
    }
    let source = () => resolveConfig(current)
    sctx.settings.installSection(ctx, SETTINGS_NS, Config, current, {
      setSource: (next) => {
        source = () => resolveConfig(next())
        current = source()
      },
      onChange: () => {
        current = source()
        cache.clear()
      },
    })
  })

  ctx.logger?.info?.(
    `dsh-search-fusion: provider "${PROVIDER_ID}", strategy "${current.strategy}", `
    + `chain [${[current.primary, ...current.fallback].join(' -> ')}], maxResults ${current.maxResults}`,
  )
}

/* ------------------------------------------------------------------ */
/* Model-facing tools                                                  */
/* ------------------------------------------------------------------ */

function registerFusionTools(ctx, api) {
  const statusTool = defineTool({
    name: 'search_fusion_status',
    description:
      'Show the search-fusion configuration (primary engine, fallback chain, strategy), '
      + 'the engines available, cache statistics and the last search outcome.',
    parameters: {},
    async execute() {
      const config = api.getConfig()
      const report = api.getReport()
      const lines = [
        `primary engine: ${config.primary}`,
        `fallback chain: ${config.fallback.length === 0 ? '(none)' : config.fallback.join(' -> ')}`,
        `strategy: ${config.strategy}`,
        `available engines: ${BACKEND_IDS.join(', ')}`,
        `max results: ${config.maxResults} (fusion triggers below ${config.minResults})`,
        `cache: ${config.cacheEnabled ? 'enabled' : 'disabled'}, ttl ${config.cacheTtlMs} ms, `
          + `${api.cache.stats().size} entries, ${api.cache.stats().hits} hits / ${api.cache.stats().misses} misses`,
        `last search: ${report === null ? 'none yet' : `${report.at} engines=[${report.engines.join(', ')}]${report.cached ? ' (cached)' : ''}${report.error === null ? '' : ` error=${report.error}`}`}`,
      ]
      return lines.join('\n')
    },
  })

  const switchTool = defineTool({
    name: 'search_fusion_switch',
    description:
      'Switch the primary search engine and/or the fallback chain used by web_search. '
      + 'Takes effect on the next search; no restart needed.',
    parameters: {
      primary: { type: 'string', description: `Primary engine id; one of: ${BACKEND_IDS.join(', ')}` },
      fallback: {
        type: 'array',
        items: { type: 'string' },
        description: 'Engines to try, in order, when the primary fails or underdelivers.',
      },
    },
    async execute(args) {
      const config = api.getConfig()
      if (args.primary !== undefined && !isBackendId(args.primary)) {
        throw new Error(`unknown engine "${args.primary}"; available: ${BACKEND_IDS.join(', ')}`)
      }
      const unknown = (args.fallback ?? []).filter((id) => !isBackendId(id))
      if (unknown.length > 0) {
        throw new Error(`unknown engine(s) in fallback: ${unknown.join(', ')}; available: ${BACKEND_IDS.join(', ')}`)
      }
      const next = {
        ...config,
        ...args.primary === undefined ? {} : { primary: args.primary },
        ...args.fallback === undefined ? {} : { fallback: args.fallback.filter((id) => id !== (args.primary ?? config.primary)) },
      }
      api.setConfig(next)
      return `search fusion updated: primary "${next.primary}", fallback [${next.fallback.join(' -> ')}]. The next web_search uses it immediately.`
    },
  })

  ctx.tools.register(statusTool)
  ctx.tools.register(switchTool)
}
