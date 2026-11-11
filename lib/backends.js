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
export async function fetchText(url, { signal, headers, timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS, method = 'GET', body, proxyFetch } = {}) {
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

/* ------------------------------------------------------------------ */
/* User-defined JSON search engines                                     */
/* ------------------------------------------------------------------ */

/**
 * A custom engine is a JSON API the user configures in the settings page: an
 * endpoint URL, an optional credential reference, and a small field mapping.
 * Everything below is deliberately tolerant — a half-filled row must never
 * crash plugin loading; `normalizeCustomEngines()` decides what is usable.
 */
const CUSTOM_ID_RE = /^[a-z0-9_-]{1,32}$/

/**
 * Presets: the "paste a key and an endpoint, nothing else" path.
 *
 * A preset is a bag of default field values plus a `match` list of hostnames.
 * The settings page never asks the user to pick a preset: they paste the
 * endpoint, the hostnames are matched against it, and the name + technical
 * fields follow automatically. The name stays editable, so a mirror of the same
 * API can be called whatever it is.
 *
 * `transport: 'mcp'` means the endpoint speaks Model Context Protocol: one
 * `initialize` handshake, then `tools/call`. The tool's text payload is then
 * parsed with the same `resultsPath` / field mapping as a plain JSON API, so
 * both transports share one result pipeline.
 */
export const ENGINE_PRESETS = [
  {
    id: 'tavily',
    label: 'Tavily',
    match: ['api.tavily.com'],
    transport: 'rest',
    url: 'https://api.tavily.com/search',
    method: 'POST',
    apiKeyEnv: 'TAVILY_API_KEY',
    authHeader: 'Authorization: Bearer {key}',
    bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
    resultsPath: 'results',
    urlField: 'url',
    titleField: 'title',
    snippetField: 'content',
  },
  {
    id: 'tavily-mcp',
    label: 'Tavily',
    match: ['mcp.tavily.com'],
    transport: 'mcp',
    url: 'https://mcp.tavily.com/mcp/',
    method: 'POST',
    apiKeyEnv: 'TAVILY_API_KEY',
    mcpTool: 'tavily_search',
    mcpQueryArg: 'query',
    mcpMaxResultsArg: 'max_results',
    resultsPath: 'results',
    urlField: 'url',
    titleField: 'title',
    snippetField: 'content',
  },
  {
    id: 'custom',
    label: '自定义 JSON API',
    match: [],
    transport: 'rest',
    url: '',
    method: 'GET',
    apiKeyEnv: '',
    authHeader: 'Authorization: Bearer {key}',
    bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
    resultsPath: 'results',
    urlField: 'url',
    titleField: 'title',
    snippetField: 'snippet',
    mcpTool: '',
    mcpQueryArg: 'query',
    mcpMaxResultsArg: 'max_results',
  },
]

/** Preset ids, in the order the settings page lists them. */
export const PRESET_IDS = ENGINE_PRESETS.map((preset) => preset.id)

/** Look up a preset; `undefined` for an unknown or missing id. */
export function findPreset(id) {
  if (typeof id !== 'string') return undefined
  return ENGINE_PRESETS.find((preset) => preset.id === id.trim().toLowerCase())
}

/**
 * Ask an engine name from a URL: the settings page types the endpoint and the
 * page fills in the name and the technical defaults.
 *
 * Matching is on hostname only (never the path), and the LAST matching preset
 * wins so a more specific entry can be appended later without reordering. An
 * unrecognized URL still yields a usable name: the registrable host, title-cased
 * (`https://search.acme.io/v1` -> `Acme`), so the row is never called "自定义".
 *
 * @param {string} url - endpoint the user typed.
 * @param {Array} presets - preset catalog to match against.
 * @returns `{ preset, id, label, host }`; `preset === undefined` when unknown.
 */
export function inferEngineFromUrl(url, presets = ENGINE_PRESETS) {
  const text = typeof url === 'string' ? url.trim() : ''
  let host = ''
  if (text !== '') {
    try {
      host = new URL(text).hostname.toLowerCase()
    } catch {
      host = ''
    }
  }
  if (host !== '') {
    let matched
    for (const preset of presets) {
      for (const pattern of preset.match ?? []) {
        // `api.tavily.com` and `*.tavily.com` style entries both work.
        const stem = String(pattern).replace(/^\*\./, '').toLowerCase()
        if (stem !== '' && (host === stem || host.endsWith(`.${stem}`))) matched = preset
      }
    }
    if (matched !== undefined) {
      return { preset: matched, id: matched.id, label: matched.label, host }
    }
  }
  return { preset: undefined, id: '', label: host === '' ? '' : humanizeHost(host), host }
}

/** `api.search.acme.co.uk` -> `Acme`; `my-api.example` -> `Example`. */
function humanizeHost(host) {
  // Drop a leading API/service prefix and the public suffix, then title-case the
  // last meaningful label: `api.search.acme.co.uk` -> `Acme`.
  const labels = host.split('.').filter((part) => part !== '')
  const suffixes = new Set(['com', 'net', 'org', 'io', 'ai', 'cn', 'co', 'uk', 'dev', 'app', 'sh', 'so', 'me', 'us', 'jp', 'de'])
  const meaningful = labels.filter((part) => !suffixes.has(part))
  const base = meaningful.length > 0 ? meaningful[meaningful.length - 1] : (labels[labels.length - 1] ?? '')
  const cleaned = base.replace(/^(api|search|www|mcp|api-)+/i, '').replace(/[^a-z0-9-]/gi, '')
  if (cleaned === '') return base
  return cleaned.replace(/(^|[-_])([a-z0-9])/gi, (_m, sep, ch) => (sep === '' ? ch.toUpperCase() : ch.toUpperCase()))
}

/**
 * A URL-safe engine id derived from a name (`Acme Search` -> `acme-search`).
 * Returns '' when the name holds nothing id-shaped (e.g. Chinese), so callers
 * keep whatever id the row already had instead of inventing a meaningless one.
 */
export function engineIdFromName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** Defaults used when a definition names no preset (or an unknown one). */
const NO_PRESET = {
  transport: 'rest',
  url: '',
  method: 'GET',
  apiKeyEnv: '',
  authHeader: 'Authorization: Bearer {key}',
  bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
  resultsPath: 'results',
  urlField: 'url',
  titleField: 'title',
  snippetField: 'snippet',
  mcpTool: '',
  mcpQueryArg: 'query',
  mcpMaxResultsArg: 'max_results',
}

/** Built-in engines: immutable, always present. */
const BUILTIN_ADAPTERS = new Map([
  ['bing', bingAdapter],
  ['ddg', ddgAdapter],
  ['ddg-lite', ddgLiteAdapter],
  ['searxng', searxngAdapter],
  ['anysearch', anysearchAdapter],
])

/** Live registry: built-ins plus whatever custom engines are installed. */
export const ADAPTERS = new Map(BUILTIN_ADAPTERS)


/** Stable list of backend ids, in a stable order (used for config validation). */
export const BACKEND_IDS = [...BUILTIN_ADAPTERS.keys()]

/** Current ids including custom engines — prefer this over the frozen array. */
export function backendIds() {
  return [...ADAPTERS.keys()]
}

export function isBackendId(value) {
  return typeof value === 'string' && ADAPTERS.has(value)
}

export function isBuiltinId(value) {
  return BUILTIN_ADAPTERS.has(value)
}

/**
 * Validate and normalize one user-supplied engine definition.
 * Returns a clean definition, or throws with a reason the caller can log.
 */
export function normalizeCustomEngine(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) throw new Error('definition must be an object')
  const id = typeof def.id === 'string' ? def.id.trim().toLowerCase() : ''
  if (!CUSTOM_ID_RE.test(id)) throw new Error(`invalid id "${def.id}" (use 1-32 chars: a-z, 0-9, _, -)`)
  if (isBuiltinId(id)) throw new Error(`id "${id}" is reserved by a built-in engine`)

  // A preset only fills gaps: every explicit field on the row wins, so the user
  // can start from Tavily and still override the endpoint or a JSON path.
  // `id`/`label` are never taken from the preset — they identify THIS row.
  const preset = findPreset(def.preset) ?? NO_PRESET
  const { id: _presetId, label: _presetLabel, ...presetFields } = preset
  const raw = { ...NO_PRESET, ...stripUndefined(presetFields), ...stripUndefined(def) }
  const str = (v, fallback) => typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback
  const url = str(raw.url, '')
  if (!/^https?:\/\//i.test(url)) throw new Error(`id "${id}": url must be an absolute http(s) URL`)
  const transport = str(raw.transport, 'rest').toLowerCase() === 'mcp' ? 'mcp' : 'rest'
  return {
    id,
    label: str(def.label, preset === NO_PRESET || preset.id === 'custom' ? id : preset.label),
    preset: preset === NO_PRESET ? 'custom' : preset.id,
    transport,
    url,
    // MCP is JSON-RPC over POST whatever the user picked in the method column.
    method: transport === 'mcp' ? 'POST' : (String(raw.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'),
    apiKeyEnv: str(raw.apiKeyEnv, ''),
    authHeader: str(raw.authHeader, 'Authorization: Bearer {key}'),
    resultsPath: str(raw.resultsPath, 'results'),
    urlField: str(raw.urlField, 'url'),
    titleField: str(raw.titleField, 'title'),
    snippetField: str(raw.snippetField, 'snippet'),
    bodyTemplate: str(raw.bodyTemplate, '{"query":"{query}","max_results":{maxResults}}'),
    mcpTool: str(raw.mcpTool, ''),
    mcpQueryArg: str(raw.mcpQueryArg, 'query'),
    mcpMaxResultsArg: str(raw.mcpMaxResultsArg, 'max_results'),
  }
}

/** Copy only the present, non-empty keys — so a preset never erases a real '' default. */
function stripUndefined(source) {
  if (source === null || typeof source !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue
    out[key] = value
  }
  return out
}

/**
 * Validate a whole list, reporting every rejected row.
 *
 * A silently dropped row is the worst failure mode of a settings page: the
 * user presses 保存, the page says 已保存, and the engine is simply not there
 * after the next restart. Same rules as {@link normalizeCustomEngines}; the
 * difference is that the reasons travel back to the caller instead of being
 * swallowed, so the save route can refuse the write and name the bad row.
 *
 * @param list - raw `customEngines` rows from a config or a settings save.
 * @returns `{ engines, errors }` with normalized rows and user-facing reasons.
 */
export function validateCustomEngines(list) {
  const engines = []
  const errors = []
  if (!Array.isArray(list)) return { engines, errors }
  const seen = new Set()
  list.forEach((raw, index) => {
    try {
      const def = normalizeCustomEngine(raw)
      if (seen.has(def.id)) throw new Error(`duplicate id "${def.id}"`)
      seen.add(def.id)
      engines.push(def)
    } catch (error) {
      const label = typeof raw?.id === 'string' && raw.id.trim() !== ''
        ? `引擎 "${raw.id.trim()}"`
        : `第 ${index + 1} 个引擎`
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return { engines, errors }
}

/** Validate a whole list; drop invalid/duplicate rows, keep the rest. */
export function normalizeCustomEngines(list) {
  return validateCustomEngines(list).engines
}

/**
 * Install custom engines into the live ADAPTERS registry.
 * Returns a disposer that removes exactly the ids installed by this call.
 */
export function installCustomEngines(defs) {
  /**
   * Adapter instance per id that THIS call put into the registry.
   *
   * Ownership is tracked by identity, not by a global id set. The plugin is
   * rebuilt whenever its config changes, so the new instance must be able to
   * take an engine over from the old one. With a global "already installed" set
   * the new instance skipped the install, and then the old instance's disposer
   * deleted the engine outright — it disappeared from the registry entirely.
   */
  const owned = new Map()
  for (const def of normalizeCustomEngines(defs)) {
    const adapter = createCustomAdapter(def)
    ADAPTERS.set(def.id, adapter)
    owned.set(def.id, adapter)
  }
  return () => {
    for (const [id, adapter] of owned) {
      // Remove only what is still ours: a newer instance may have replaced the
      // adapter, and deleting it then would unregister a live engine.
      if (ADAPTERS.get(id) === adapter) ADAPTERS.delete(id)
    }
    owned.clear()
  }
}

/** Fill `{query}` / `{maxResults}` / `{key}` placeholders in a template. */
function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_all, key) => {
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

/** Read a dotted path out of a parsed JSON response. */
function pathValue(root, dotted) {
  let node = root
  for (const part of String(dotted).split('.').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/** Pick the first non-empty string among several fields on a result item. */
function pickField(item, primary, fallbacks) {
  for (const key of [primary, ...fallbacks]) {
    const value = typeof item?.[key] === 'string' ? item[key].trim() : ''
    if (value.length > 0) return value
  }
  return ''
}

/**
 * Build a standard adapter from a normalized custom-engine definition.
 * `opts.apiKey` is the resolved secret for this engine id (never the env name).
 */
export function createCustomAdapter(def) {
  const normalized = normalizeCustomEngine(def)
  return {
    id: normalized.id,
    label: normalized.label,
    free: normalized.apiKeyEnv === '',
    async search(query, { maxResults, apiKey, proxyFetch, timeoutMs } = {}, signal) {
      const key = typeof apiKey === 'string' ? apiKey.trim() : ''
      if (normalized.apiKeyEnv !== '' && key === '') {
        throw new Error(`${normalized.id} requires a credential; set ${normalized.apiKeyEnv} in DSH credentials or the environment`)
      }

      const values = { query, maxResults, key }
      const headers = { accept: 'application/json' }
      if (key !== '') {
        const rendered = fillTemplate(normalized.authHeader, values)
        const match = /^\s*([^:\s]+)\s*:\s*([\s\S]*)$/.exec(rendered)
        if (match !== null) headers[match[1]] = match[2].trim()
      }

      // Two transports, one result pipeline: both end at `parsed`, and both are
      // read with the same resultsPath + field mapping.
      let parsed
      if (normalized.transport === 'mcp') {
        parsed = await mcpSearch(normalized, { values, headers, proxyFetch, timeoutMs, signal })
      } else {
        // Query in the URL: use the template if present, otherwise append q/query.
        let url = fillTemplate(normalized.url, values)
        if (!url.includes('{query}') && !/[?&](q|query)=/.test(url)) {
          try {
            const withParams = new URL(url)
            withParams.searchParams.set('q', query)
            withParams.searchParams.set('maxResults', String(maxResults))
            url = withParams.toString()
          } catch {
            // normalizeCustomEngine already validated the URL; leave as-is.
          }
        }
        if (normalized.method === 'POST') headers['content-type'] = 'application/json'
        const body = normalized.method === 'POST'
          ? fillTemplate(normalized.bodyTemplate, values)
          : undefined
        const text = await fetchText(url, {
          signal, headers, method: normalized.method, body, proxyFetch, timeoutMs,
        })
        parsed = parseJsonOrFail(text, normalized.id)
      }

      const rows = pathValue(parsed, normalized.resultsPath)
      if (!Array.isArray(rows)) {
        throw new Error(`${normalized.id}: results path "${normalized.resultsPath}" is not an array`)
      }

      const sources = []
      for (const row of rows) {
        const absolute = absolutize(pickField(row, normalized.urlField, ['link', 'href']), normalized.url)
        if (absolute === '') continue
        const title = pickField(row, normalized.titleField, ['name', 'heading'])
        const snippet = pickField(row, normalized.snippetField, ['content', 'description', 'abstract'])
        sources.push({
          url: absolute,
          ...title !== '' ? { title } : {},
          ...snippet !== '' ? { snippet } : {},
        })
        if (sources.length >= maxResults) break
      }
      return { sources, truncated: false, engine: normalized.id }
    },
  }
}

/** Parse a response body, or throw the message the settings page should show. */
function parseJsonOrFail(text, engineId) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${engineId}: API did not return valid JSON`)
  }
}

/**
 * Minimal MCP client: `initialize` handshake -> `notifications/initialized` ->
 * `tools/call`, over streamable HTTP (JSON or SSE framed, same session id).
 *
 * Deliberately stateless — a search opens and drops its own session. That costs
 * two extra round trips per search but needs no lifecycle, no reuse policy and
 * no cleanup when a credential or the endpoint changes.
 *
 * @returns the parsed JSON the tool returned, ready for `resultsPath` lookup.
 */
async function mcpSearch(normalized, { values, headers, proxyFetch, timeoutMs, signal }) {
  const { query, maxResults } = values
  const doFetch = resolveFetch(proxyFetch)
  const base = { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  const state = { sessionId: '', protocolVersion: '', nextId: 1 }
  // ONE budget for the whole session: three requests each with their own timeout
  // would let a slow handshake plus a slow call run to 3x the configured limit.
  const bounded = boundedSignal(signal, timeoutMs)

  const post = async (payload) => {
    const requestHeaders = { 'user-agent': UA, ...base }
    if (state.sessionId !== '') requestHeaders['mcp-session-id'] = state.sessionId
    if (state.protocolVersion !== '') requestHeaders['mcp-protocol-version'] = state.protocolVersion
    const response = await doFetch(normalized.url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload),
      signal: bounded,
      redirect: 'follow',
    })
    const returned = response.headers?.get?.('mcp-session-id')
    if (typeof returned === 'string' && returned !== '') state.sessionId = returned
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${normalized.id}: MCP HTTP ${response.status} ${response.statusText}${text === '' ? '' : ` (${firstLine(text)})`}`)
    }
    return parseMcpFrames(text, response.headers?.get?.('content-type'))
  }

  // 1. Handshake. The server answers with its protocol version and session id.
  const initId = state.nextId++
  const initFrames = await post({
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-search-fusion', version: '0.1.0' },
    },
  })
  const initReply = initFrames.find((frame) => frame?.id === initId) ?? initFrames[0]
  if (initReply?.error !== undefined) {
    throw new Error(`${normalized.id}: MCP initialize failed: ${initReply.error?.message ?? JSON.stringify(initReply.error)}`)
  }
  const negotiated = initReply?.result?.protocolVersion
  if (typeof negotiated === 'string' && negotiated !== '') state.protocolVersion = negotiated

  // 2. The spec's "I am ready" notification; servers may answer 202 with no body.
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })

  // 3. The actual search.
  const tool = normalized.mcpTool === '' ? 'tavily_search' : normalized.mcpTool
  const args = {
    [normalized.mcpQueryArg]: query,
    [normalized.mcpMaxResultsArg]: maxResults,
  }
  const callId = state.nextId++
  const callFrames = await post({
    jsonrpc: '2.0',
    id: callId,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  })
  const callReply = callFrames.find((frame) => frame?.id === callId) ?? callFrames[0]
  if (callReply === undefined) {
    throw new Error(`${normalized.id}: MCP returned no JSON-RPC response for tools/call`)
  }
  if (callReply.error !== undefined) {
    throw new Error(`${normalized.id}: MCP ${tool} failed: ${callReply.error?.message ?? JSON.stringify(callReply.error)}`)
  }

  const result = callReply.result
  if (result?.isError === true) {
    throw new Error(`${normalized.id}: MCP ${tool} reported an error: ${mcpText(result) || 'no detail'}`)
  }
  const text = mcpText(result)
  if (text === '') throw new Error(`${normalized.id}: MCP ${tool} returned no text content`)
  return parseJsonOrFail(text, normalized.id)
}

/** Concatenate the text parts of an MCP tool result. */
function mcpText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

/** Pull JSON-RPC frames out of a JSON body or an SSE stream. */
function parseMcpFrames(text, contentType) {
  const body = String(text ?? '').trim()
  if (body === '') return []
  if (/event-stream/i.test(String(contentType ?? '')) || /^\s*(event|data):/m.test(body)) {
    const frames = []
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data === '' || data === '[DONE]') continue
      try { frames.push(JSON.parse(data)) } catch { /* keep-alive or partial frame */ }
    }
    return frames
  }
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Bound one MCP request so a hanging handshake cannot hold the search. */
function boundedSignal(signal, timeoutMs) {
  const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_ENGINE_TIMEOUT_MS
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal ?? undefined
  const timeout = AbortSignal.timeout(budget)
  if (signal === undefined || signal === null) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
}

function firstLine(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200)
}
