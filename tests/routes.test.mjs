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

/** Boot the routes on an ephemeral port and return a small client. */
async function boot({ settings, credentials } = {}) {
  const routes = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const state = { current: resolveConfig({}) }
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
  assert.ok(body.value.builtins.includes('searxng'))
  assert.ok(Array.isArray(body.value.config.customEngines))
  assert.ok(!('apiKey' in body.value.config), 'must never expose a secret')
  ok('returns the effective config and engine catalog')
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
  const updates = []
  const app = await boot({ settings: { update: async (ns, patch) => { updates.push(patch) } } })
  await fetch(`${app.base}${ROUTE}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { customEngines: [{ id: 'BAD ID' }, { id: 'bing' }, { id: 'ok', url: 'https://x.example/s' }] } }),
  })
  assert.equal(updates[0].customEngines.length, 1)
  assert.equal(updates[0].customEngines[0].id, 'ok')
  ok('invalid drafts are normalized before they reach the profile')
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
