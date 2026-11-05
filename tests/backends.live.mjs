/**
 * Live smoke test for the backend adapters.
 *
 * Hits real engines, so it is NOT part of the offline suite: free engines rate
 * limit, and a failure here may mean "the vendor changed markup", "the network is
 * down" or "we are throttled" — all of which are informative but not hermetic.
 *
 *   node tests/backends.live.mjs            # run every engine
 *   node tests/backends.live.mjs bing ddg   # run a subset
 */
import { ADAPTERS, BACKEND_IDS, stripHtml } from '../lib/backends.js'

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const engines = requested.length > 0 ? requested : BACKEND_IDS

console.log(`live adapter check: ${engines.join(', ')}\n`)

let failures = 0
for (const engineId of engines) {
  const adapter = ADAPTERS.get(engineId)
  if (adapter === undefined) {
    console.log(`${engineId.padEnd(10)} SKIP  unknown engine`)
    continue
  }
  const started = Date.now()
  try {
    const result = await adapter.search('DeepSeek Harness', { maxResults: 5, locale: 'zh-CN' })
    const elapsed = Date.now() - started
    const first = result.sources[0]
    console.log(
      `${engineId.padEnd(10)} OK    ${String(result.sources.length).padStart(2)} sources in ${String(elapsed).padStart(5)} ms`
      + (first === undefined ? '  (empty!)' : `  first: ${String(first.title ?? '(no title)').slice(0, 60)}`),
    )
    if (result.sources.length === 0) failures += 1
    for (const source of result.sources) {
      if (!/^https?:\/\//.test(source.url)) {
        console.log(`           BAD URL: ${source.url}`)
        failures += 1
      }
    }
  } catch (error) {
    const elapsed = Date.now() - started
    console.log(`${engineId.padEnd(10)} FAIL  ${String(elapsed).padStart(5)} ms  ${error instanceof Error ? error.message : String(error)}`)
    failures += 1
  }
}

// Sanity-check the HTML stripper the parsers depend on.
const stripped = stripHtml('<b>Hello</b>&nbsp;<i>world</i><script>bad()</script>')
if (stripped !== 'Hello world') {
  console.log(`FAIL stripHtml: got ${JSON.stringify(stripped)}`)
  failures += 1
} else {
  console.log('stripHtml  OK')
}

console.log(`\n${failures === 0 ? 'all adapters answered' : `${failures} adapter check(s) failed`}\n`)
process.exitCode = failures === 0 ? 0 : 1
