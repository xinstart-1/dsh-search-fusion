/**
 * Offline tests for the pure logic: URL canonicalization, fusion ranking and the
 * LRU/TTL cache. These run without a DSH host, so they are cheap to re-run while
 * iterating on ranking behaviour.
 */
import assert from 'node:assert/strict'
import { canonicalizeUrl, fuseResults, renderReport } from '../lib/fusion.js'
import { SearchCache } from '../lib/cache.js'

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

console.log('\ncanonicalizeUrl')

test('drops hash, trailing slash and tracking params', () => {
  assert.equal(
    canonicalizeUrl('https://Example.com/a/?utm_source=x&b=1#frag'),
    'https://example.com/a?b=1',
  )
})

test('keeps path case, lowers host', () => {
  assert.equal(canonicalizeUrl('https://WWW.Example.COM/Path'), 'https://www.example.com/Path')
})

test('rejects non-http and junk', () => {
  assert.equal(canonicalizeUrl('mailto:a@b.c'), '')
  assert.equal(canonicalizeUrl(''), '')
  assert.equal(canonicalizeUrl(undefined), '')
  assert.equal(canonicalizeUrl('not a url'), '')
})

console.log('\nfuseResults')

test('merges the same URL from two engines and boosts agreement', () => {
  const fused = fuseResults([
    { engine: 'bing', sources: [{ url: 'https://a.example/x', title: 'A' }, { url: 'https://b.example/y', title: 'B' }] },
    { engine: 'ddg', sources: [{ url: 'https://a.example/x?utm_source=ddg', snippet: 'S' }] },
  ], { maxResults: 10 })
  assert.equal(fused.sources.length, 2)
  const agreed = fused.details.find((item) => item.host === 'a.example')
  assert.deepEqual(agreed.engines, ['bing', 'ddg'])
  assert.equal(agreed.agreement, 1)
  // Agreement outranks a single-engine hit without one.
  assert.equal(fused.details[0].host, 'a.example')
  // Snippet from the second engine fills the gap left by the first.
  assert.equal(fused.sources[0].snippet, 'S')
})

test('truncates to maxResults and reports the pre-cap total', () => {
  const sources = Array.from({ length: 8 }, (_, i) => ({ url: `https://e.example/${i}` }))
  const fused = fuseResults([{ engine: 'bing', sources }], { maxResults: 3 })
  assert.equal(fused.sources.length, 3)
  assert.equal(fused.truncated, true)
  assert.equal(fused.totalBeforeCap, 8)
})

test('keeps primary engine order among equal scores', () => {
  const fused = fuseResults([
    { engine: 'bing', sources: [{ url: 'https://one.example/', title: 'T1' }, { url: 'https://two.example/', title: 'T2' }] },
  ], { maxResults: 10 })
  assert.deepEqual(fused.sources.map((s) => s.url), ['https://one.example/', 'https://two.example/'])
})

test('applies engine weights', () => {
  const fused = fuseResults([
    { engine: 'bing', sources: [{ url: 'https://light.example/' }] },
    { engine: 'searxng', sources: [{ url: 'https://heavy.example/' }] },
  ], { engineWeights: { searxng: 5 }, maxResults: 10 })
  assert.equal(fused.details[0].host, 'heavy.example')
})

test('drops unusable URLs entirely', () => {
  const fused = fuseResults([{ engine: 'bing', sources: [{ url: '' }, { url: 'mailto:x@y.z' }, { url: 'https://ok.example/' }] }])
  assert.equal(fused.sources.length, 1)
})

console.log('\nrenderReport')

test('mentions engines, merging and agreement', () => {
  const fused = fuseResults([
    { engine: 'bing', sources: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/' }] },
    { engine: 'ddg', sources: [{ url: 'https://a.example/' }] },
  ], { maxResults: 10 })
  const report = renderReport({
    enginesTried: ['bing', 'ddg'],
    enginesAnswered: ['bing', 'ddg'],
    fused,
    cached: false,
    elapsedMs: 42,
  })
  assert.match(report, /2 engine\(s\) queried/)
  assert.match(report, /Cross-engine agreement: 1/)
  assert.match(report, /42 ms/)
})

console.log('\nSearchCache')

test('returns a stored value within TTL', () => {
  const cache = new SearchCache({ ttlMs: 1000 })
  const key = SearchCache.key({ query: ' Hello World ', engines: ['bing', 'ddg'], maxResults: 5 })
  cache.set(key, { sources: [] })
  assert.deepEqual(cache.get(key), { sources: [] })
  // Key is normalized: query case, whitespace and engine order do not matter.
  assert.deepEqual(cache.get(SearchCache.key({ query: 'hello   world', engines: ['ddg', 'bing'], maxResults: 5 })), { sources: [] })
})

test('expires entries past TTL', () => {
  const cache = new SearchCache({ ttlMs: 1 })
  const key = 'k'
  cache.set(key, 1)
  const start = Date.now()
  while (Date.now() - start < 5) { /* spin briefly */ }
  assert.equal(cache.get(key), undefined)
})

test('evicts the least recently used entry beyond maxEntries', () => {
  const cache = new SearchCache({ ttlMs: 10_000, maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // refresh 'a' so 'b' becomes the LRU victim
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('reports stats', () => {
  const cache = new SearchCache()
  cache.set('x', 1)
  cache.get('x')
  cache.get('y')
  const stats = cache.stats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.size, 1)
})

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}\n`)
