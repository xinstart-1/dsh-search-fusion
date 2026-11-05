/**
 * Offline test entry: every suite that must pass without network access.
 *
 *   node tests/run-offline.mjs
 *
 * The live suites (`backends.live.mjs`, `proxy.live.mjs`) are intentionally
 * excluded: they depend on a proxy and on the engines being reachable, so they
 * belong in a pre-release check, not in the loop.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = ['fusion.test.mjs', 'parsers.test.mjs', 'provider.test.mjs']

let failed = 0
for (const suite of suites) {
  console.log(`\n===== ${suite} =====`)
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed += 1
    console.error(`<<< ${suite} FAILED (exit ${result.status})`)
  }
}

console.log(`\n===== ${failed === 0 ? 'all suites passed' : `${failed} suite(s) failed`} =====\n`)
process.exitCode = failed === 0 ? 0 : 1
