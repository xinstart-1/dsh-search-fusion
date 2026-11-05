/**
 * Parser regression tests against HTML captured from the live engines.
 *
 * The fixtures in `tests/fixtures/` are verbatim responses (trimmed only by the
 * capture script). Testing against real bytes is what catches the class of bug
 * that a hand-written snippet would miss — e.g. DuckDuckGo using a multi-class
 * container (`"result results_links results_links_deep web-result"`), which a
 * naive `class="result"` block regex silently parses into zero results.
 *
 * Refresh a fixture with:  node tests/dump-engines.mjs <proxy>
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBing, parseDuckDuckGo, parseDuckDuckGoLite, parseSearxngJson } from '../lib/backends.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

function fixture(name) {
  const file = path.join(fixtures, name)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

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

console.log('\nDuckDuckGo HTML')

const ddgHtml = fixture('ddg.html')
if (ddgHtml === null) {
  console.log('  skip (no fixture; run tests/dump-engines.mjs)')
} else {
  test('parses results from the multi-class result container', () => {
    const sources = parseDuckDuckGo(ddgHtml, 10)
    assert.ok(sources.length >= 5, `expected >= 5 results, got ${sources.length}`)
    for (const source of sources) {
      assert.match(source.url, /^https:\/\//)
      assert.ok((source.title ?? '').length > 0, 'every result should carry a title')
    }
  })

  test('keeps snippets and strips tags', () => {
    const sources = parseDuckDuckGo(ddgHtml, 10)
    const withSnippet = sources.filter((s) => (s.snippet ?? '').length > 0)
    assert.ok(withSnippet.length > 0, 'expected at least one snippet')
    for (const source of withSnippet) {
      assert.doesNotMatch(source.snippet, /<[a-z/]/i)
    }
  })

  test('honours maxResults', () => {
    assert.equal(parseDuckDuckGo(ddgHtml, 3).length, 3)
  })
}

console.log('\nDuckDuckGo Lite')

const liteHtml = fixture('ddg-lite.html')
if (liteHtml === null) {
  console.log('  skip (no fixture)')
} else {
  test('parses the lite result table', () => {
    const sources = parseDuckDuckGoLite(liteHtml, 10)
    assert.ok(sources.length >= 3, `expected >= 3 results, got ${sources.length}`)
    for (const source of sources) assert.match(source.url, /^https?:\/\//)
  })
}

console.log('\nBing')

const bingHtml = fixture('bing.html')
if (bingHtml === null) {
  console.log('  skip (no fixture)')
} else if (/Object moved/i.test(bingHtml)) {
  console.log('  skip (fixture is the 302 redirect page, not a result page)')
} else {
  test('parses b_algo blocks', () => {
    const sources = parseBing(bingHtml, 10, 'https://cn.bing.com')
    assert.ok(sources.length >= 3, `expected >= 3 results, got ${sources.length}`)
    for (const source of sources) assert.match(source.url, /^https?:\/\//)
  })
}

console.log('\nSearXNG JSON')

test('parses a well-formed payload', () => {
  const payload = JSON.stringify({
    results: [
      { url: 'https://a.example/x', title: 'A', content: 'about A' },
      { url: 'https://b.example/y', title: 'B' },
      { url: '', title: 'no url' },
    ],
  })
  const sources = parseSearxngJson(payload, 10, 'https://searx.be')
  assert.equal(sources.length, 2)
  assert.equal(sources[0].title, 'A')
  assert.equal(sources[0].snippet, 'about A')
})

test('returns [] for a non-JSON body instead of throwing', () => {
  // Public instances commonly answer with an HTML error page.
  assert.deepEqual(parseSearxngJson('<html>nope</html>', 10, 'https://searx.be'), [])
})

const searxFixture = fixture('searx.html')
if (searxFixture !== null && searxFixture.trimStart().startsWith('{')) {
  test('parses the captured live payload', () => {
    const sources = parseSearxngJson(searxFixture, 5, 'https://searx.be')
    assert.ok(Array.isArray(sources))
    for (const source of sources) assert.match(source.url, /^https?:\/\//)
  })
}

console.log(`\n${passed} checks passed${process.exitCode === 1 ? ' (with failures)' : ''}\n`)
