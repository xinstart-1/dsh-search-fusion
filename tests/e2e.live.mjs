/**
 * End-to-end acceptance: drive a real FusionProvider against the real engines.
 *
 *   node tests/e2e.live.mjs http://127.0.0.1:7897
 *
 * This is the check that "the plugin actually works", as opposed to the offline
 * suites which prove the logic. It reports the cost accounting for each strategy,
 * because request count is the whole point of the design.
 */
import { FusionProvider } from '../lib/provider.js'
import { SearchCache } from '../lib/cache.js'
import { createProxyFetch } from '../lib/proxy.js'

const proxy = process.argv[2] ?? ''
const proxyFetch = proxy === '' ? undefined : createProxyFetch(proxy)
console.log(`proxy: ${proxy === '' ? '(direct)' : proxy}\n`)

let requestCount = 0
const countingFetch = async (url, init) => {
  requestCount += 1
  return (proxyFetch ?? fetch)(url, init)
}

function providerFor(config) {
  const state = {
    config: () => ({ ...base, ...config, proxyFetch: countingFetch }),
    cache: new SearchCache({ ttlMs: 60_000 }),
    report: null,
    prepare: async () => {},
  }
  return { provider: new FusionProvider(state), state }
}

const base = { locale: 'zh-CN', maxResults: 10, engineTimeoutMs: 15_000, cacheEnabled: true }

async function run(label, config, query = 'DeepSeek Harness') {
  const { provider } = providerFor(config)
  requestCount = 0
  const started = Date.now()
  try {
    const result = await provider.search({ query, maxResults: 10 })
    const elapsed = Date.now() - started
    console.log(`${label}`)
    console.log(`  ${result.sources.length} sources, ${requestCount} request(s), ${elapsed} ms`)
    console.log(`  ${result.content}`)
    for (const source of result.sources.slice(0, 3)) {
      console.log(`    - ${source.url}`)
    }
    console.log('')
    return result
  } catch (error) {
    console.log(`${label}`)
    console.log(`  FAILED after ${requestCount} request(s): ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return null
  }
}

await run('1. sequential (cheapest: expect 1 request)', {
  strategy: 'sequential',
  primary: 'bing',
  fallback: ['ddg', 'ddg-lite', 'searxng'],
})

await run('2. fusion, rich answer (expect 1 request)', {
  strategy: 'fusion',
  primary: 'bing',
  fallback: ['ddg', 'ddg-lite'],
  minResults: 5,
})

await run('3. fusion, thin answer forced (expect 2+ requests)', {
  strategy: 'fusion',
  primary: 'bing',
  fallback: ['ddg', 'ddg-lite', 'searxng'],
  // maxResults caps what each engine is asked for, so minResults must exceed it
  // to guarantee escalation — otherwise a healthy engine answers in full and the
  // cheap path is (correctly) taken.
  maxResults: 5,
  minResults: 6,
}, 'dsh-search-fusion README 里那个很长的、几乎不可能有八条结果的查询字符串')

await run('4. always-fuse (expect one request per engine)', {
  strategy: 'always-fuse',
  primary: 'bing',
  fallback: ['ddg', 'ddg-lite'],
})

// 5. Cache: the second identical search must cost zero requests.
{
  // One provider instance, one cache: two searches through the SAME instance.
  const { provider } = providerFor({ strategy: 'fusion', primary: 'bing', fallback: ['ddg'], minResults: 5 })
  requestCount = 0
  const first = await provider.search({ query: 'cache probe query', maxResults: 10 })
  const afterFirst = requestCount
  const second = await provider.search({ query: 'cache probe query', maxResults: 10 })
  const afterSecond = requestCount
  const servedFromCache = /query cache/.test(second.content)
  const ok = afterSecond === afterFirst && servedFromCache
  console.log('5. cache (expect 0 extra requests)')
  console.log(`  first=${afterFirst} requests, second=${afterSecond} requests, servedFromCache=${servedFromCache} -> ${ok ? 'OK' : 'FAIL'}`)
  console.log(`  same sources: ${JSON.stringify(first.sources.map((s) => s.url)) === JSON.stringify(second.sources.map((s) => s.url))}\n`)
  if (!ok) process.exitCode = 1
}

// 6. Failure path: a chain of engines that cannot answer.
{
  const { provider } = providerFor({ strategy: 'fusion', primary: 'searxng', fallback: [], searxngInstances: ['https://127.0.0.1:1'] })
  try {
    await provider.search({ query: 'x', maxResults: 5 })
    console.log('6. failure path\n  FAIL: expected an error\n')
    process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('6. failure path')
    console.log(`  OK: ${message.slice(0, 120)}`)
    console.log(`  code=${error.code}\n`)
    if (!/all search backends failed/.test(message)) process.exitCode = 1
  }
}

console.log(process.exitCode === 1 ? 'e2e: FAILURES\n' : 'e2e: all checks passed\n')
