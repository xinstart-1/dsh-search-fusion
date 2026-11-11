/**
 * Offline tests for the host half of the settings routes.
 *
 * The routes are plain Node HTTP handlers, so a real http.Server can drive them
 * with no host packages and no browser.
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { registerConfigRoutes, ROUTE, SETTINGS_NS } from '../lib/routes.js'
import { resolveConfig } from '../lib/index.js'
import { normalizeCustomEngines } from '../lib/backends.js'

let checks = 0
const ok = (name) => { checks += 1; console.log('  ok  ' + name) }

/**
 * In-memory stand-in for lib/store.js, so a route test can assert what the
 * save persisted without touching the real profile directory.
 */
function makeStore() {
  const state = { path: '/tmp/cordis.patch.state.json', savedAt: '', saved: [] }
  return {
    state,
    api: {
      path: state.path,
      read: () => (state.saved.length === 0 ? undefined : { version: 1, savedAt: state.savedAt, config: state.saved.at(-1) }),
      save: (config) => {
        state.saved.push(structuredClone(config))
        state.savedAt = '2026-11-11T04:00:00.000Z'
        return true
      },
    },
  }
}

/** Boot the routes on an ephemeral port and return a small client. */
async function boot({ settings, credentials, store, recovered } = {}) {
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const state = { current: resolveConfig({}) }
  const logs = []
  const ctx = {
    get: (name) => {
      if (name === 'settings') return settings
      if (name === 'credentials') return credentials
      return undefined
    },
    webServer,
  }
  registerConfigRoutes(ctx, {
    getCurrent: () => state.current,
    replaceCurrent: (next) => { state.current = next },
    resolveConfig,
    normalizeCustomEngines,
    store: store?.api,
    recovered,
    log: (level, message) => { logs.push({ level, message }) },
  })
  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.equal(route.path, `${ROUTE}/config`)

  const server = http.createServer((req, res) => {
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500).end(String(error))
      else res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    state,
    logs,
    route,
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/* ------------------------------------------------------------------ */
console.log('\nGET /config')

{
  const app = await boot()
  const res = await fetch(`${app.base}${ROUTE}/config`)
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.config.primary, 'bing')
  assert.deepEqual(body.value.builtins, ['bing', 'ddg', 'ddg-lite', 'searxng'])
  assert.equal(body.value.builtins.includes('anysearch'), false)
  assert.ok(Array.isArray(body.value.config.customEngines))
  assert.ok(!('apiKey' in body.value.config), 'must never expose a secret')
  ok('returns the effective config and engine catalog')
  await app.close()
}

{
  const updates = []
  const app = await boot({ settings: { update: async (_ns, patch) => { updates.push(patch) } } })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: {
      primary: 'anysearch',
      customEngines: [{ id: 'anysearch', preset: 'anysearch', url: 'https://api.anysearch.ai/v1/search', apiKeyEnv: 'ANYSEARCH_API_KEY' }],
    } }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(updates[0].customEngines[0].id, 'anysearch')
  assert.equal(app.state.current.customEngines[0].url, 'https://api.anysearch.ai/v1/search')
  ok('validates and saves AnySearch as a preset custom engine')
  await app.close()
}

/* ------------------------------------------------------------------ */
console.log('\nPOST /config')

{
  const updates = []
  const app = await boot({
    settings: {
      update: async (ns, patch) => { updates.push({ ns, patch }) },
    },
  })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        primary: 'myapi',
        fallback: ['bing'],
        customEngines: [
          { id: 'myapi', label: 'Mine', url: 'https://api.example.com/s?q={query}', apiKeyEnv: 'MY_KEY' },
        ],
      },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].ns, SETTINGS_NS)
  assert.equal(updates[0].patch.primary, 'myapi')
  assert.equal(updates[0].patch.customEngines.length, 1)
  assert.equal(app.state.current.primary, 'myapi')
  assert.match(body.value.engines.join(','), /myapi/)
  ok('writes through settings.update and returns the new snapshot')
  await app.close()
}

{
  // A rejected row used to be dropped silently: the page said 已保存 and the
  // engine was missing after the next restart. A save now fails loudly and
  // writes nothing (no profile update, no credential, no snapshot).
  const updates = []
  const store = makeStore()
  const app = await boot({ settings: { update: async (ns, patch) => { updates.push(patch) } }, store })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { customEngines: [{ id: 'BAD ID' }, { id: 'bing' }, { id: 'ok', url: 'https://x.example/s' }] } }),
  })
  const body = await res.json()
  assert.equal(res.status, 400)
  assert.match(body.error, /无法写入/)
  assert.equal(body.details.length, 2, JSON.stringify(body.details))
  assert.ok(body.details.some((line) => line.includes('BAD ID')))
  assert.ok(body.details.some((line) => line.includes('bing') && line.includes('reserved')))
  assert.equal(updates.length, 0)
  assert.equal(store.state.saved.length, 0)
  ok('an invalid engine row rejects the whole save and names every bad row')
  await app.close()
}

{
  const updates = []
  const app = await boot({ settings: { update: async (ns, patch) => { updates.push(patch) } } })
  const cases = [
    [{ primary: 'nope' }, /主引擎 "nope" 不可用/],
    [{ fallback: ['bing', 'ghost'] }, /回退链里的 "ghost" 不可用/],
    [{ maxResults: 0 }, /maxResults 必须是正整数/],
    [{ strategy: 'fastest' }, /策略 "fastest" 无效/],
  ]
  for (const [patch, expected] of cases) {
    const res = await fetch(`${app.base}${ROUTE}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    })
    const body = await res.json()
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.ok(body.details.some((line) => expected.test(line)), `${JSON.stringify(patch)} -> ${JSON.stringify(body.details)}`)
  }
  assert.equal(updates.length, 0)
  ok('dangling engine ids and silently clamped values are rejected with a reason')
  await app.close()
}

{
  // The save must also refresh the durable snapshot: that copy is what lets the
  // plugin survive a profile patch that the desktop recovery flow renamed away.
  const updates = []
  const store = makeStore()
  const app = await boot({ settings: { update: async (ns, patch) => { updates.push(patch) } }, store })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        primary: 'kept',
        customEngines: [{ id: 'kept', preset: 'custom', url: 'https://x.example/s', apiKeyEnv: 'K_KEY' }],
      },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(store.state.saved.length, 1)
  assert.equal(store.state.saved[0].customEngines[0].id, 'kept')
  assert.equal(body.value.persisted, true)
  assert.equal(body.value.store.path, '/tmp/cordis.patch.state.json')
  ok('a successful save also writes the durable snapshot')
  await app.close()
}

/* ------------------------------------------------------------------ */
console.log('\\nrecovery from the durable snapshot')

{
  // The load-time merge already restored the engines (index.js). The first page
  // read writes them back into the profile patch, once.
  const updates = []
  const store = makeStore()
  store.state.saved.push({ customEngines: [{ id: 'kept', url: 'https://x.example/s' }] })
  store.state.savedAt = '2026-11-11T04:00:00.000Z'
  const app = await boot({
    settings: { update: async (ns, patch) => { updates.push({ ns, patch }) } },
    store,
    recovered: ['customEngines', 'proxy'],
  })
  app.state.current = resolveConfig({
    primary: 'kept',
    proxy: 'http://127.0.0.1:7897',
    customEngines: [{ id: 'kept', preset: 'custom', url: 'https://x.example/s' }],
  })

  const firstRes = await fetch(`${app.base}${ROUTE}/config`)
  const first = await firstRes.json()
  assert.equal(firstRes.status, 200)
  assert.deepEqual(first.value.store.recovered, ['customEngines', 'proxy'])
  assert.deepEqual(first.value.store.recoveredLabels, ['自定义搜索引擎', '代理'])
  assert.equal(updates.length, 1)
  assert.equal(updates[0].patch.customEngines[0].id, 'kept')
  assert.equal(updates[0].patch.proxy, 'http://127.0.0.1:7897')
  ok('the page reports what was recovered and writes it back into the profile once')

  await fetch(`${app.base}${ROUTE}/config`).then((res) => res.json())
  assert.equal(updates.length, 1, 'the repair must not rewrite on every page read')
  ok('the repair runs once, not on every page load')
  await app.close()
}

{
  // After a save the banner must clear: the profile and the snapshot agree again.
  const store = makeStore()
  const recovered = ['customEngines']
  const app = await boot({ settings: { update: async () => {} }, store, recovered })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { customEngines: [{ id: 'fresh', preset: 'custom', url: 'https://x.example/s' }] } }),
  })
  assert.equal(res.status, 200)
  assert.equal(recovered.length, 0)
  assert.deepEqual(store.state.saved.at(-1).customEngines.map((e) => e.id), ['fresh'])
  ok('saving replaces the recovery state and the snapshot')
  await app.close()
}

{
  const app = await boot() // no settings service
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { primary: 'bing' } }),
  })
  const body = await res.json()
  assert.equal(res.status, 503)
  assert.match(body.error, /settings service unavailable/)
  ok('missing settings service answers 503 with a clear message (no throw)')
  await app.close()
}

{
  const app = await boot({ settings: { update: async () => {} } })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  })
  const body = await res.json()
  assert.equal(res.status, 400)
  ok('malformed body is a 400, not a crashed handler')
  await app.close()
}

/* ------------------------------------------------------------------ */
console.log('\nkey storage (paste a key, keep the ref)')

{
  const stored = {}
  const updates = []
  const descriptors = []
  const app = await boot({
    settings: { update: async (ns, patch) => { updates.push({ ns, patch }) } },
    credentials: {
      set: async (ref, value) => { stored[ref] = value },
      describe: async (ref) => { descriptors.push(ref); return { configured: ref in stored, writable: true } },
    },
  })

  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        primary: 'tavily',
        fallback: ['bing'],
        customEngines: [{
          id: 'tavily',
          preset: 'tavily',
          transport: 'rest',
          url: 'https://api.tavily.com/search',
          apiKeyEnv: 'TAVILY_API_KEY',
        }],
        secrets: { tavily: 'tvly-pasted-key' },
      },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.deepEqual(stored, { TAVILY_API_KEY: 'tvly-pasted-key' })
  ok('a pasted key is written to the credentials service under its ref')

  assert.ok(!JSON.stringify(updates[0].patch).includes('tvly-pasted-key'), 'the secret must never reach the profile')
  assert.equal(updates[0].patch.customEngines[0].apiKeyEnv, 'TAVILY_API_KEY')
  ok('the profile patch keeps only the ref name, never the secret')

  assert.equal(body.value.keys.tavily.configured, true)
  assert.equal(body.value.canStoreKeys, true)
  assert.ok(!JSON.stringify(body.value).includes('tvly-pasted-key'))
  ok('the snapshot reports "configured" without echoing the value')
  await app.close()
}

{
  // A row with no ref gets a derived one, so the page never has to invent a name.
  const stored = {}
  const app = await boot({
    settings: { update: async () => {} },
    credentials: { set: async (ref, value) => { stored[ref] = value }, describe: async () => ({ configured: false }) },
  })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        customEngines: [{ id: 'my-api', preset: 'custom', url: 'https://x.example/s' }],
        secrets: { 'my-api': 'plain-key' },
      },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.deepEqual(stored, { DSH_SEARCH_MY_API_KEY: 'plain-key' })
  assert.equal(app.state.current.customEngines[0].apiKeyEnv, 'DSH_SEARCH_MY_API_KEY')
  ok('a key on a ref-less row is stored under a derived DSH_SEARCH_<ID>_KEY ref')
  await app.close()
}

{
  // Engine ids are normalized to lowercase, so a key must follow the same rule
  // even if the page happened to stage it under a mixed-case row id.
  const stored = {}
  const app = await boot({
    settings: { update: async () => {} },
    credentials: { set: async (ref, value) => { stored[ref] = value }, describe: async () => ({ configured: false }) },
  })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: {
        customEngines: [{ id: 'MySearch', preset: 'custom', url: 'https://x.example/s', apiKeyEnv: 'MY_KEY' }],
        secrets: { mysearch: 'mixed-key' },
      },
    }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(stored, { MY_KEY: 'mixed-key' })
  assert.equal(app.state.current.customEngines[0].id, 'mysearch')
  ok('a staged key follows the lowercase engine id and its own ref')
  await app.close()
}

{
  // No credentials service: say so instead of silently dropping the key.
  const app = await boot({ settings: { update: async () => {} } })
  const res = await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: { customEngines: [{ id: 't', url: 'https://x.example/s', apiKeyEnv: 'T_KEY' }], secrets: { t: 'v' } },
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 500)
  assert.match(body.error, /credentials service is unavailable/)
  ok('without a credentials service, storing a key fails loudly')
  await app.close()
}

/* ------------------------------------------------------------------ */
console.log('\nroute safety')

{
  const app = await boot({ settings: { update: async () => {} } })
  const res = await fetch(`${app.base}${ROUTE}/config`, { method: 'DELETE' })
  assert.equal(res.status, 405)
  ok('unsupported methods are rejected')
  await app.close()
}

console.log(`\n${checks} checks passed\n`)
