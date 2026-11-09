/**
 * Regression: an engine added in the settings page must be usable on the NEXT
 * search, without restarting DSH.
 *
 * Two failures made that false before:
 *   1. installCustomEngines() used a global "already installed" id set, so a
 *      rebuilt plugin instance skipped the install and the old instance's
 *      disposer then deleted the engine from the registry.
 *   2. Saving only replaced the in-memory config; the adapter registry was left
 *      untouched until the next restart.
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { ADAPTERS, backendIds, installCustomEngines, isBackendId } from '../lib/backends.js'
import { registerConfigRoutes } from '../lib/routes.js'
import { resolveConfig } from '../lib/index.js'
import { normalizeCustomEngines } from '../lib/backends.js'

let checks = 0
const ok = (label) => { checks += 1; console.log('  ok  ' + label) }

/* ------------------------------------------------------------------ */
console.log('\nregistry handover between plugin instances')

{
  const defs = [{ id: 'handover', url: 'https://api.example.com/search', method: 'POST' }]
  const disposeOld = installCustomEngines(defs)
  const disposeNew = installCustomEngines(defs)
  assert.ok(isBackendId('handover'))
  disposeOld()
  assert.ok(isBackendId('handover'), 'disposing the OLD instance must not unregister the NEW adapter')
  ok('a rebuilt instance takes the engine over; the old disposer leaves it alone')
  disposeNew()
  assert.ok(!isBackendId('handover'))
  ok('the owning instance still removes its engine')
}

{
  // Removing an engine from the config must actually drop it.
  const dispose = installCustomEngines([{ id: 'gone', url: 'https://a.example/s' }])
  assert.ok(isBackendId('gone'))
  dispose()
  assert.ok(!isBackendId('gone'))
  ok('an engine removed from the config is unregistered')
}

/* ------------------------------------------------------------------ */
console.log('\nsaving the settings page registers the engine immediately')

{
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  let current = resolveConfig({})
  let engineDisposer = installCustomEngines(current.customEngines)

  const reinstall = (next) => {
    engineDisposer()
    engineDisposer = installCustomEngines(next?.customEngines)
  }
  registerConfigRoutes(
    { get: (name) => (name === 'settings' ? { update: async () => {} } : undefined), webServer },
    {
      getCurrent: () => current,
      replaceCurrent: (next) => { current = next; reinstall(next) },
      resolveConfig,
      normalizeCustomEngines,
    },
  )

  const server = http.createServer((req, res) => {
    Promise.resolve(routes[0].handler(req, res)).catch((error) => res.writeHead(500).end(String(error)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  assert.ok(!isBackendId('tavily'), 'not registered before the save')
  const res = await fetch(`${base}/plugins/dsh-search-fusion/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        primary: 'tavily',
        fallback: ['bing'],
        customEngines: [{
          id: 'tavily', preset: 'tavily', url: 'https://api.tavily.com/search',
          apiKeyEnv: 'TAVILY_API_KEY',
        }],
      },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.ok(isBackendId('tavily'), 'saving must register the adapter right away')
  assert.ok(backendIds().includes('tavily'))
  assert.equal(current.primary, 'tavily')
  ok('POST /config registers the new engine; no restart needed')

  // The engine must also be reachable by the switch tool's validation path.
  assert.equal(isBackendId('tavily'), true)
  ok('the new id passes isBackendId, so search_fusion_switch accepts it')

  await new Promise((resolve) => server.close(resolve))
  engineDisposer()
}

console.log(`\n${checks} checks passed\n`)
