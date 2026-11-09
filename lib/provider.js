/**
 * The fusion provider itself: the single search provider registered into
 * `ctx.web`, which decides how many engines to ask and how to merge them.
 *
 * Cost model (the reason this plugin exists)
 * ------------------------------------------
 * Free engines have quotas, so the default path asks exactly one engine:
 *
 *   sequential   — ask `primary`; on failure walk `fallback` in order.
 *                  Never asks a second engine that could have answered, so the
 *                  baseline cost is one request, same as a plain router.
 *   fusion       — ask `primary` first; only spend more requests when the result
 *                  is thin (`minResults`) or empty. This is the default: zero
 *                  extra cost for a normal query, extra cost only when the first
 *                  engine underdelivered.
 *   always-fuse  — ask every configured engine up front, in parallel. Explicit
 *                  opt-in for the case where the caller genuinely wants
 *                  multi-engine coverage (cross-checking, citation building).
 *
 * The provider always reports which engines answered, so cost is never hidden.
 */
/**
 * `@deepseek-ai/dsh-web` is a host-provided peer: it resolves inside the running
 * harness but not when this module is imported by a standalone test or script.
 * Loading it lazily keeps the provider importable outside the host, and the
 * fallback keeps error paths working there too (only the marker differs).
 */
let webErrorCtor = null

async function loadWebError() {
  if (webErrorCtor !== null) return webErrorCtor
  try {
    const module = await import('@deepseek-ai/dsh-web')
    webErrorCtor = module.WebError ?? null
  } catch {
    webErrorCtor = null
  }
  return webErrorCtor
}

async function webError(message, code, cause) {
  const Ctor = await loadWebError()
  if (Ctor !== null) return new Ctor(message, code, { cause })
  const error = new Error(message, { cause })
  error.code = code
  return error
}
import { ADAPTERS, DEFAULT_ENGINE_TIMEOUT_MS } from './backends.js'
import { fuseResults, renderReport } from './fusion.js'
import { SearchCache } from './cache.js'

export const PROVIDER_ID = 'fusion'

/** Fusion strategies, cheapest first. */
export const STRATEGIES = ['sequential', 'fusion', 'always-fuse']

export class FusionProvider {
  id = PROVIDER_ID

  #state

  /**
   * @param state - shared plugin state: `{ config, cache, report }`, where
   *                `config` is a live getter so settings changes apply to the
   *                next search without re-registering the provider.
   */
  constructor(state) {
    this.#state = state
  }

  available() {
    return true
  }

  async search(request, signal) {
    // Refresh the credential snapshot once per search: keys rotate without a restart.
    try {
      await this.#state.prepare?.()
    } catch {
      // A failed credential refresh keeps the previous snapshot; free engines
      // still work and a key-requiring engine will report its own error.
    }
    const config = this.#state.config()
    const strategy = STRATEGIES.includes(config.strategy) ? config.strategy : 'fusion'
    const maxResults = clampMaxResults(request.maxResults ?? config.maxResults, config.maxResults)
    const engineWeights = config.engineWeights ?? {}

    const chain = buildChain(config)
    const cacheKey = SearchCache.key({ query: request.query, engines: chain, maxResults })

    if (config.cacheEnabled) {
      const cached = this.#state.cache.get(cacheKey)
      if (cached !== undefined) {
        const report = renderReport({ ...cached.report, cached: true })
        this.#record({ engines: cached.report.enginesAnswered, cached: true, error: null })
        return { ...cached.result, content: report }
      }
    }

    const startedAt = Date.now()
    const enginesTried = []
    const enginesAnswered = []
    const batches = []
    let lastError = null

    const runEngine = async (engineId) => {
      const adapter = ADAPTERS.get(engineId)
      if (adapter === undefined) throw new Error(`unknown engine "${engineId}"`)
      enginesTried.push(engineId)
      const credentials = config.credentials ?? {}
      const result = await adapter.search(
        request.query,
        {
          maxResults,
          locale: config.locale,
          instances: config.searxngInstances,
          apiKey: credentials[engineId],
          proxyFetch: config.proxyFetch,
          timeoutMs: config.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS,
        },
        withTimeout(signal, config.engineTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS),
      )
      enginesAnswered.push(result.engine ?? engineId)
      batches.push({ engine: result.engine ?? engineId, sources: result.sources })
      return result
    }

    try {
      if (strategy === 'always-fuse') {
        const requested = chain
        const settled = await Promise.allSettled(requested.map((engineId) => runEngine(engineId)))
        for (const outcome of settled) {
          if (outcome.status === 'rejected') lastError = messageOf(outcome.reason)
        }
      } else {
        // sequential + fusion share the same walk; `fusion` only decides to keep
        // going after a *successful* but thin answer.
        for (const engineId of chain) {
          try {
            const result = await runEngine(engineId)
            if (strategy === 'sequential') break
            // strategy === 'fusion': stop when the answer is good enough.
            if (result.sources.length >= minResultsFor(config, maxResults)) break
          } catch (error) {
            lastError = `${engineId}: ${messageOf(error)}`
          }
        }
      }
    } catch (error) {
      // Only reachable for programming errors; engine failures are handled above.
      throw await webError(`fusion search failed: ${messageOf(error)}`, 'WEB_PROVIDER_ERROR', error)
    }

    if (batches.length === 0 || batches.every((batch) => batch.sources.length === 0)) {
      this.#record({ engines: enginesTried, cached: false, error: lastError })
      throw await webError(
        `all search backends failed (${enginesTried.join(' -> ')}): ${lastError ?? 'no results'}`,
        'WEB_PROVIDER_ERROR',
        lastError === null ? undefined : new Error(lastError),
      )
    }

    const fused = fuseResults(batches, { engineWeights, maxResults })
    const elapsedMs = Date.now() - startedAt
    const reportMeta = { enginesTried, enginesAnswered, fused, elapsedMs }
    const report = renderReport({ ...reportMeta, cached: false })

    if (config.cacheEnabled) {
      this.#state.cache.set(cacheKey, {
        result: { sources: fused.sources, truncated: fused.truncated },
        report: reportMeta,
      })
    }

    this.#record({ engines: enginesAnswered, cached: false, error: lastError })

    return {
      sources: fused.sources,
      truncated: fused.truncated,
      // `content` is surfaced by the official web_search tool as the answer
      // preamble, so the agent can see the cost accounting.
      content: report,
    }
  }

  #record(entry) {
    this.#state.report = { ...entry, at: new Date().toISOString() }
  }
}

function buildChain(config) {
  const primary = typeof config.primary === 'string' && ADAPTERS.has(config.primary) ? config.primary : 'bing'
  const fallback = Array.isArray(config.fallback)
    ? config.fallback.filter((id) => typeof id === 'string' && ADAPTERS.has(id) && id !== primary)
    : []
  return [primary, ...fallback]
}

function minResultsFor(config, maxResults) {
  const configured = config.minResults
  if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
    // Deliberately NOT clamped to maxResults: `minResults` is a threshold, not a
    // result limit. Clamping made `minResults > maxResults` silently mean
    // "escalate never", which is the opposite of what the caller asked for.
    return configured
  }
  // Default: "thin" means fewer than half of what was asked for.
  return Math.max(1, Math.ceil(maxResults / 2))
}

function clampMaxResults(requested, configured) {
  const cap = typeof configured === 'number' && configured > 0 ? configured : 10
  const value = typeof requested === 'number' && Number.isInteger(requested) && requested > 0 ? requested : cap
  return Math.min(value, cap)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Bound one engine call so a hanging engine cannot hold the whole search. */
function withTimeout(signal, timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    const timeout = AbortSignal.timeout(timeoutMs)
    return signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout])
  }
  return signal ?? undefined
}
