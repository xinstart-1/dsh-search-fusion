/**
 * Backend adapters: every engine is reduced to `search(query, opts, signal)`.
 *
 * Design notes
 * ------------
 * - Adapters never throw WebError; they throw plain Error so the orchestrator can
 *   decide whether the failure is fatal for the request or just for one backend.
 * - Every adapter returns `{ sources, truncated }` in the provider-neutral shape
 *   that `ctx.web` expects, plus `engine` accounting for the fusion report.
 * - HTML-scraping adapters (bing/ddg/searxng) are best-effort: they parse the
 *   server-rendered result list. They break when the vendor changes markup, so
 *   each one tags its failures clearly enough to appear in `lastFailure`.
 */

/** Default per-request timeout for a single engine call. */
export const DEFAULT_ENGINE_TIMEOUT_MS = 12_000

/** Default User-Agent; some engines serve a bare 403 to unknown agents. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Engines that are unreachable from mainland China without a proxy.
 *
 * Node's global `fetch` honours neither `HTTP_PROXY` nor `HTTPS_PROXY`, so a
 * deployment behind a local proxy needs the request to go through a dispatcher
 * explicitly. We avoid a hard dependency on `undici` (it is not guaranteed to be
 * installed in the host): instead the caller can pass `proxyFetch`, a function
 * with the same signature as `fetch` that already knows how to reach the proxy.
 * When it is absent we fall back to the global fetch, which works on networks
 * with direct access.
 */
function resolveFetch(proxyFetch) {
  if (typeof proxyFetch === 'function') return proxyFetch
  return (...args) => fetch(...args)
}

/** Strip tags and collapse whitespace from an HTML fragment. */
export function stripHtml(input) {
  if (typeof input !== 'string') return ''
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Decode the redirect wrapper DuckDuckGo uses (`/l/?uddg=<encoded>`). */
function decodeDuckDuckGoHref(href) {
  if (typeof href !== 'string') return ''
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m === null) return href
  try {
    return decodeURIComponent(m[1])
  } catch {
    return href
  }
}

/** Resolve a possibly-relative href against a base URL. */
function absolutize(href, base) {
  if (typeof href !== 'string' || href.length === 0) return ''
  try {
    return new URL(href, base).toString()
  } catch {
    return ''
  }
}

/** Fetch text with a timeout bound to the caller's AbortSignal. */
async function fetchText(url, { signal, headers, timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS, method = 'GET', body, proxyFetch } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const doFetch = resolveFetch(proxyFetch)
  try {
    const response = await doFetch(url, {
      method,
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...headers },
      body,
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      // 429 is qualitatively different from a 5xx: the engine is alive and the
      // request was valid, we are just being throttled. The message says so,
      // because it changes what the user should do (retry later / add a proxy
      // instance) versus (fix the query / report a bug).
      const hint = response.status === 429 ? ' (rate limited; try again later or configure another instance)' : ''
      throw new Error(`HTTP ${response.status} ${response.statusText}${hint}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }
}

function requireCredential(value, engineId) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${engineId} requires a credential; set it in the plugin settings or the credential env var`)
  }
  return value.trim()
}

/* ------------------------------------------------------------------ */
/* Bing (HTML)                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bing serves a server-rendered list; `b_algo` blocks hold title + href + snippet.
 * Market/locale come from `setlang` / `mkt` so the profile can pin Chinese results.
 */
export const bingAdapter = {
  id: 'bing',
  label: 'Bing',
  free: true,
  async search(query, { maxResults, locale = 'zh-CN', proxyFetch, timeoutMs } = {}, signal) {
    const params = new URLSearchParams({
      q: query,
      count: String(Math.max(maxResults * 2, 20)),
      setlang: locale.split('-')[0],
      mkt: locale,
    })
    // www.bing.com answers with a 302 to the regional host; asking the regional
    // host directly saves a round trip and keeps the market consistent.
    const host = /^zh/i.test(locale) ? 'cn.bing.com' : 'www.bing.com'
    const url = `https://${host}/search?${params.toString()}`
    const html = await fetchText(url, { signal, proxyFetch, timeoutMs })
    return { sources: parseBing(html, maxResults, `https://${host}`), truncated: false, engine: 'bing' }
  },
}

/* ------------------------------------------------------------------ */
/* DuckDuckGo (HTML + Lite)                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse the DuckDuckGo HTML endpoint.
 *
 * Real markup (verified 2026-11-05) looks like:
 *   <div class="result results_links results_links_deep web-result ">
 *     <a rel="nofollow" class="result__a" href="https://…">Title</a>
 *     … <a class="result__snippet" href="…">Snippet</a>
 *
 * Note the multi-class `class` attribute and that the snippet is itself an <a>
 * rather than a <p>, which is why a naive `result__snippet</a>` capture works and
 * a block regex anchored on `class="result"` does not.
 */
function parseDuckDuckGo(html, maxResults) {
  const sources = []
  // Split on every result container; the container carries several classes, so
  // match the *set* rather than an exact string.
  const blockRe = /<div[^>]+class="[^"]*\bresults_links\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresults_links\b|<\/body>)/gi
  for (const block of html.match(blockRe) ?? []) {
    const anchor = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (anchor === null) continue
    const absolute = absolutize(decodeDuckDuckGoHref(anchor[1]), 'https://duckduckgo.com')
    if (absolute.length === 0) continue
    const snippetMatch = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const title = stripHtml(anchor[2])
    const snippet = stripHtml(snippetMatch?.[1])
    sources.push({
      url: absolute,
      ...title.length > 0 ? { title } : {},
      ...snippet.length > 0 ? { snippet } : {},
    })
    if (sources.length >= maxResults) break
  }
  return sources
}

export const ddgAdapter = {
  id: 'ddg',
  label: 'DuckDuckGo',
  free: true,
  async search(query, { maxResults, proxyFetch, timeoutMs } = {}, signal) {
    const params = new URLSearchParams({ q: query, kl: 'cn-zh' })
    // The query belongs in the POST body only. Putting it in the URL *and* the
    // body sends DuckDuckGo two `q` values, and it answers with an empty result
    // page rather than an error — a silent zero, not a failure.
    const html = await fetchText('https://html.duckduckgo.com/html/', {
      signal,
      proxyFetch,
      timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    return { sources: parseDuckDuckGo(html, maxResults), truncated: false, engine: 'ddg' }
  },
}

export const ddgLiteAdapter = {
  id: 'ddg-lite',
  label: 'DuckDuckGo Lite',
  free: true,
  async search(query, { maxResults, proxyFetch, timeoutMs } = {}, signal) {
    const params = new URLSearchParams({ q: query, kl: 'cn-zh' })
    const html = await fetchText('https://lite.duckduckgo.com/lite/', {
      signal,
      proxyFetch,
      timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    return { sources: parseDuckDuckGoLite(html, maxResults), truncated: false, engine: 'ddg-lite' }
  },
}

/* ------------------------------------------------------------------ */
/* SearXNG (JSON API)                                                  */
/* ------------------------------------------------------------------ */

/**
 * SearXNG is a meta-search server; `format=json` gives clean structured results.
 * Many public instances disable the JSON endpoint, which is why several
 * instances are tried in order before the backend is considered failed.
 */
export const searxngAdapter = {
  id: 'searxng',
  label: 'SearXNG',
  free: true,
  async search(query, { maxResults, instances, proxyFetch, timeoutMs } = {}, signal) {
    // Order matters: the first two answered a JSON probe from this network, the
    // rest are fallbacks that frequently rate-limit (429) public clients.
    const list = Array.isArray(instances) && instances.length > 0
      ? instances
      : ['https://searx.be', 'https://search.inetol.net', 'https://priv.au']
    let lastError = null
    for (const base of list) {
      try {
        const params = new URLSearchParams({
          q: query,
          format: 'json',
          language: 'zh-CN',
          safesearch: '1',
        })
        const text = await fetchText(`${base.replace(/\/$/, '')}/search?${params.toString()}`, {
          signal,
          proxyFetch,
          timeoutMs,
          headers: { accept: 'application/json' },
        })
        const sources = parseSearxngJson(text, maxResults, base)
        if (sources.length > 0) return { sources, truncated: false, engine: `searxng(${new URL(base).host})` }
        lastError = `${base} returned 0 results`
      } catch (error) {
        lastError = `${base}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    throw new Error(lastError ?? 'searxng: no instance answered')
  },
}

/* ------------------------------------------------------------------ */
/* AnySearch (REST)                                                    */
/* ------------------------------------------------------------------ */

/**
 * AnySearch is the existing first-class integration in this profile; keeping it
 * as an adapter here means fusion can treat it as just another engine instead of
 * a hard dependency.
 */
export const anysearchAdapter = {
  id: 'anysearch',
  label: 'AnySearch',
  free: false,
  async search(query, { maxResults, apiKey, baseURL = 'https://api.anysearch.ai', proxyFetch, timeoutMs } = {}, signal) {
    const key = requireCredential(apiKey, 'anysearch')
    const doFetch = resolveFetch(proxyFetch)
    const response = await doFetch(`${baseURL.replace(/\/$/, '')}/v1/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': UA,
      },
      body: JSON.stringify({ query, maxResults }),
      signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const parsed = await response.json()
    const sources = []
    for (const item of Array.isArray(parsed?.results) ? parsed.results : []) {
      const absolute = absolutize(item?.url, baseURL)
      if (absolute.length === 0) continue
      const title = typeof item?.title === 'string' ? item.title.trim() : ''
      const snippet = typeof item?.snippet === 'string' ? item.snippet.trim() : ''
      sources.push({
        url: absolute,
        ...title.length > 0 ? { title } : {},
        ...snippet.length > 0 ? { snippet } : {},
      })
      if (sources.length >= maxResults) break
    }
    return { sources, truncated: false, engine: 'anysearch' }
  },
}

/** Exported for offline parser tests against saved HTML fixtures. */
export { parseDuckDuckGo, parseDuckDuckGoLite, parseBing, parseSearxngJson }

/** Parse a Bing result page. */
function parseBing(html, maxResults, base = 'https://cn.bing.com') {
  const sources = []
  const blockRe = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/gi
  for (const block of html.match(blockRe) ?? []) {
    const href = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"/i.exec(block)?.[1]
    const title = /<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1]
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1]
    const absolute = absolutize(href, base)
    if (absolute.length === 0) continue
    const cleanTitle = stripHtml(title)
    const cleanSnippet = stripHtml(snippet)
    sources.push({
      url: absolute,
      ...cleanTitle.length > 0 ? { title: cleanTitle } : {},
      ...cleanSnippet.length > 0 ? { snippet: cleanSnippet } : {},
    })
    if (sources.length >= maxResults) break
  }
  return sources
}

/** Parse the DuckDuckGo Lite result table. */
function parseDuckDuckGoLite(html, maxResults) {
  const sources = []
  // Two traps in this markup, both verified against a live response:
  //   1. Lite emits SINGLE-quoted attributes (`class='result-link'`);
  //   2. `href` comes BEFORE `class`, unlike the HTML endpoint.
  // So neither attribute order nor quote style can be assumed.
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorRe.exec(html)) !== null && sources.length < maxResults) {
    const attrs = match[1]
    if (!/\bresult-link\b/.test(attrs)) continue
    const href = /\bhref\s*=\s*['"]([^'"]+)['"]/i.exec(attrs)?.[1]
    const absolute = absolutize(decodeDuckDuckGoHref(href), 'https://duckduckgo.com')
    if (absolute.length === 0) continue
    const title = stripHtml(match[2])
    sources.push({ url: absolute, ...title.length > 0 ? { title } : {} })
  }
  return sources
}

/** Parse a SearXNG `format=json` payload. */
function parseSearxngJson(payload, maxResults, base) {
  const sources = []
  let parsed
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  } catch {
    return sources
  }
  for (const item of Array.isArray(parsed?.results) ? parsed.results : []) {
    const absolute = absolutize(item?.url, base)
    if (absolute.length === 0) continue
    const title = typeof item?.title === 'string' ? item.title.trim() : ''
    const snippet = typeof item?.content === 'string' ? item.content.trim() : ''
    sources.push({
      url: absolute,
      ...title.length > 0 ? { title } : {},
      ...snippet.length > 0 ? { snippet } : {},
    })
    if (sources.length >= maxResults) break
  }
  return sources
}

/** Every adapter the plugin knows about, keyed by stable backend id. */
export const ADAPTERS = new Map([
  ['bing', bingAdapter],
  ['ddg', ddgAdapter],
  ['ddg-lite', ddgLiteAdapter],
  ['searxng', searxngAdapter],
  ['anysearch', anysearchAdapter],
])

/** Stable list of backend ids, in a stable order (used for config validation). */
export const BACKEND_IDS = [...ADAPTERS.keys()]

export function isBackendId(value) {
  return typeof value === 'string' && ADAPTERS.has(value)
}
