/**
 * Verify the built-in proxy client against the real engines.
 *
 *   node tests/proxy.live.mjs http://127.0.0.1:7897
 *
 * This exists because the whole point of `lib/proxy.js` is reaching engines that
 * time out on a direct connection; a unit test with a stub socket would not prove
 * the CONNECT + TLS path works against a real proxy.
 */
import { createProxyFetch, proxyUrlFromEnv } from '../lib/proxy.js'
import { ADAPTERS, BACKEND_IDS } from '../lib/backends.js'

const proxyUrl = process.argv[2] ?? proxyUrlFromEnv()
if (proxyUrl === '') {
  console.error('no proxy given and none found in HTTPS_PROXY/HTTP_PROXY')
  process.exit(1)
}
console.log(`proxy: ${proxyUrl}\n`)

let proxyFetch
try {
  proxyFetch = createProxyFetch(proxyUrl)
} catch (error) {
  console.error(`cannot build proxy client: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

// 1. Plain HTTPS GET through the proxy.
try {
  const started = Date.now()
  const response = await proxyFetch('https://example.com/', { headers: { accept: 'text/html' } })
  const text = await response.text()
  console.log(`https GET example.com   ${response.status}  ${Date.now() - started} ms  ${text.length} bytes`)
} catch (error) {
  console.error(`https GET example.com   FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

// 2. POST through the proxy (DuckDuckGo uses form POST).
try {
  const started = Date.now()
  const response = await proxyFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'q=test',
  })
  const text = await response.text()
  console.log(`https POST ddg          ${response.status}  ${Date.now() - started} ms  ${text.length} bytes`)
} catch (error) {
  console.error(`https POST ddg          FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

// 3. Every adapter, now that requests can reach the internet.
console.log('')
for (const engineId of BACKEND_IDS) {
  const adapter = ADAPTERS.get(engineId)
  if (adapter === undefined) continue
  if (engineId === 'anysearch') {
    console.log(`${engineId.padEnd(10)} SKIP  needs a credential`)
    continue
  }
  const started = Date.now()
  try {
    const result = await adapter.search('DeepSeek Harness', { maxResults: 5, locale: 'zh-CN', proxyFetch })
    const elapsed = Date.now() - started
    const first = result.sources[0]
    console.log(
      `${engineId.padEnd(10)} OK    ${String(result.sources.length).padStart(2)} sources  ${String(elapsed).padStart(5)} ms`
      + (first === undefined ? '  (EMPTY)' : `  ${String(first.title ?? '(no title)').slice(0, 50)}`),
    )
    if (result.sources.length === 0) process.exitCode = 1
    const bad = result.sources.filter((s) => !/^https?:\/\//.test(s.url))
    if (bad.length > 0) {
      console.log(`           ${bad.length} bad URL(s): ${bad.map((b) => b.url).join(', ')}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.log(`${engineId.padEnd(10)} FAIL  ${String(Date.now() - started).padStart(5)} ms  ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
