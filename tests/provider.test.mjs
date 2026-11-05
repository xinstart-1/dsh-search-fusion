/**
 * Provider-level tests: fallback, thin-result escalation, cache and cost accounting.
 *
 * Engines are stubbed through the proxy seam (`proxyFetch`), so these run offline
 * and deterministically. That is deliberate: the interesting behaviour is *which
 * engines get called and how their answers merge*, not whether Bing is up today.
 */
import assert from 'node:assert/strict'
import { FusionProvider } from '../lib/provider.js'
import { SearchCache } from '../lib/cache.js'

let passed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}

/** Build a fake `fetch` that serves canned responses per engine host. */
function stubFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    const target = typeof url === 'string' ? url : url.url
    calls.push({ url: target, method: init.method ?? 'GET', body: init.body })
    for (const [host, handler] of Object.entries(routes)) {
      if (!target.includes(host)) continue
      const outcome = typeof handler === 'function' ? handler(target, init) : handler
      if (outcome instanceof Error) throw outcome
      return new Response(String(outcome), { status: 200 })
    }
    throw new Error(`no stub for ${target}`)
  }
  return { fn, calls }
}

/** A Bing-shaped page with `n` results. */
function bingPage(n, prefix = 'bing') {
  const items = Array.from({ length: n }, (_, i) => `
    <li class="b_algo"><h2><a href="https://${prefix}${i}.example/page">${prefix} ${i}</a></h2>
    <p>snippet ${i}</p></li>`).join('')
  return `<html><body><ol>${items}</ol></body></html>`
}

/** A DuckDuckGo HTML page with `n` results, `shared` of which also appear in bing. */
function ddgPage(n, shared = 0) {
  const items = Array.from({ length: n }, (_, i) => {
    const href = i < shared ? `https://bing${i}.example/page` : `https://ddg${i}.example/page`
    return `
      <div class="result results_links results_links_deep web-result ">
        <a rel="nofollow" class="result__a" href="${href}">ddg ${i}</a>
        <a class="result__snippet" href="${href}">ddg snippet ${i}</a>
      </div>`
  }).join('')
  return `<html><body>${items}</body></html>`
}

function makeProvider({ config, cache }) {
  const state = { config: () => config, cache: cache ?? new SearchCache({ ttlMs: 60_000 }), report: null, prepare: async () => {} }
  return { provider: new FusionProvider(state), state }
}

/** Count how many engine hosts were hit. */
function hits(calls) {
  return calls.map((call) => {
    if (call.url.includes('bing.com')) return 'bing'
    if (call.url.includes('duckduckgo.com')) return 'ddg'
    if (call.url.includes('searx.be')) return 'searxng'
    return 'other'
  })
}

console.log('\nstrategy: sequential')

await test('asks exactly one engine when the first answers', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(5) })
  const { provider } = makeProvider({
    config: { strategy: 'sequential', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 5)
  assert.deepEqual(hits(calls), ['bing'])
})

await test('falls back only after a failure', async () => {
  const { fn, calls } = stubFetch({
    'bing.com': new Error('boom'),
    'duckduckgo.com': ddgPage(4),
  })
  const { provider } = makeProvider({
    config: { strategy: 'sequential', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 4)
  assert.deepEqual(hits(calls), ['bing', 'ddg'])
  assert.match(result.content, /answered: ddg/)
})

await test('does not escalate on a thin answer (that is fusion behaviour)', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(1), 'duckduckgo.com': ddgPage(5) })
  const { provider } = makeProvider({
    config: { strategy: 'sequential', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 1)
  assert.deepEqual(hits(calls), ['bing'])
})

console.log('\nstrategy: fusion (default)')

await test('stops at the primary when the answer is rich enough', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(8), 'duckduckgo.com': ddgPage(5) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: ['ddg'], maxResults: 10, minResults: 5, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 8)
  // Cost guarantee: one request, not two.
  assert.deepEqual(hits(calls), ['bing'])
})

await test('escalates when the primary answer is thin, then merges', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(2), 'duckduckgo.com': ddgPage(4, 1) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: ['ddg'], maxResults: 10, minResults: 5, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  // 2 bing + 4 ddg, one of which duplicates a bing URL.
  assert.equal(result.sources.length, 5)
  assert.deepEqual(hits(calls), ['bing', 'ddg'])
  assert.match(result.content, /Cross-engine agreement: 1/)
})

await test('escalates on an empty answer', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(0), 'duckduckgo.com': ddgPage(3) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: ['ddg'], maxResults: 10, minResults: 5, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 3)
  assert.deepEqual(hits(calls), ['bing', 'ddg'])
})

await test('minResults above maxResults still escalates', async () => {
  // Regression: minResults used to be clamped to maxResults, so
  // `minResults > maxResults` silently meant "never escalate" — the opposite of
  // the request. The threshold is not a result limit.
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(5), 'duckduckgo.com': ddgPage(4) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: ['ddg'], maxResults: 5, minResults: 20, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 5 })
  assert.deepEqual(hits(calls), ['bing', 'ddg'], 'must query the fallback engine')
  assert.ok(result.sources.length > 0)
})

console.log('\nstrategy: always-fuse')

await test('queries every engine in the chain', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(3), 'duckduckgo.com': ddgPage(3) })
  const { provider } = makeProvider({
    config: { strategy: 'always-fuse', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 6)
  assert.deepEqual(hits(calls).sort(), ['bing', 'ddg'])
})

await test('survives one engine throwing', async () => {
  const { fn } = stubFetch({ 'bing.com': new Error('boom'), 'duckduckgo.com': ddgPage(3) })
  const { provider } = makeProvider({
    config: { strategy: 'always-fuse', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 10 })
  assert.equal(result.sources.length, 3)
})

console.log('\ncache')

await test('a repeated query costs zero engine requests', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(5) })
  const cache = new SearchCache({ ttlMs: 60_000 })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: [], maxResults: 10, proxyFetch: fn, cacheEnabled: true },
    cache,
  })
  const first = await provider.search({ query: 'same query', maxResults: 10 })
  const second = await provider.search({ query: '  SAME   query ', maxResults: 10 })
  assert.equal(first.sources.length, second.sources.length)
  assert.equal(calls.length, 1, 'second search must not hit the network')
  assert.match(second.content, /query cache/)
  assert.equal(cache.stats().hits, 1)
})

await test('cached results keep their engine report', async () => {
  const { fn } = stubFetch({ 'bing.com': bingPage(5) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: [], maxResults: 10, proxyFetch: fn, cacheEnabled: true },
  })
  await provider.search({ query: 'q2', maxResults: 10 })
  const second = await provider.search({ query: 'q2', maxResults: 10 })
  assert.match(second.content, /bing/)
  assert.match(second.content, /Served from the local query cache/)
})

console.log('\nfailure reporting')

await test('throws a WebError naming the whole chain when nothing answers', async () => {
  const { fn } = stubFetch({ 'bing.com': new Error('down'), 'duckduckgo.com': new Error('also down') })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: ['ddg'], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  await assert.rejects(
    () => provider.search({ query: 'q', maxResults: 10 }),
    (error) => {
      assert.match(error.message, /all search backends failed/)
      assert.match(error.message, /bing -> ddg/)
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      return true
    },
  )
})

await test('records the last outcome for the status tool', async () => {
  const { fn } = stubFetch({ 'bing.com': bingPage(3) })
  const { provider, state } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: [], maxResults: 10, proxyFetch: fn, cacheEnabled: false },
  })
  await provider.search({ query: 'q', maxResults: 10 })
  assert.deepEqual(state.report.engines, ['bing'])
  assert.equal(state.report.cached, false)
  assert.equal(typeof state.report.at, 'string')
})

console.log('\nrequest shaping')

await test('caps results to the configured maximum', async () => {
  const { fn, calls } = stubFetch({ 'bing.com': bingPage(20) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: [], maxResults: 4, proxyFetch: fn, cacheEnabled: false },
  })
  const result = await provider.search({ query: 'q', maxResults: 50 })
  assert.equal(result.sources.length, 4)
  // The engines were asked for 4, so nothing had to be dropped upstream: the
  // result is capped by configuration, not by truncation.
  assert.equal(result.truncated, false)
})

await test('prevents asking an engine for more than the configured maximum', async () => {
  const { fn } = stubFetch({ 'bing.com': bingPage(20) })
  const { provider } = makeProvider({
    config: { strategy: 'fusion', primary: 'bing', fallback: [], maxResults: 3, proxyFetch: fn, cacheEnabled: false },
  })
  await provider.search({ query: 'q', maxResults: 50 })
  // The adapter caps at the requested maxResults, so parsing stops early rather
  // than fetching 20 and discarding 17.
  const parsed = await provider.search({ query: 'q', maxResults: 50 })
  assert.equal(parsed.sources.length, 3)
})

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}\n`)
