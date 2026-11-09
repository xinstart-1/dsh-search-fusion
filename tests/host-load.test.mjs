import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { ADAPTERS } from '../lib/backends.js'

// Enforce the link: failure mode even on a developer machine with host packages.
const noHostPackages = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) throw new Error(`host package unavailable: ${specifier}`)
    return next(specifier, context)
  },
})
const plugin = await import('../lib/index.js')
assert.equal(plugin.name, 'dsh-search-fusion')
assert.deepEqual(plugin.inject, ['web'])
assert.equal(typeof plugin.apply, 'function')
assert.equal(plugin.Config, undefined)

function fakeHost() {
  const providers = [], tools = [], warnings = [], cleanups = [], disposed = []
  let settingsCalls = 0, watcher, settingsValue = {}
  const ctx = {
    web: { registerSearchProvider(p) { providers.push(p) } },
    credentials: { async resolve() { return { value: undefined } } },
    logger: { warn(message) { warnings.push(message) }, info() {} },
    get() { return undefined },
    inject(deps, cb) {
      const scope = {
        tools: { register(t) { tools.push(t); return () => disposed.push(t.name) } },
        settings: {
          register(ns, schema, options) {
            assert.equal(ns, 'search-fusion')
            assert.ok(schema)
            assert.equal(options.base.primary, 'bing')
            settingsCalls++
            return { get() { return settingsValue }, watch(fn) { watcher = fn } }
          },
        },
        effect(fn) { cleanups.push(fn()) },
      }
      assert.ok(['tools', 'settings'].includes(deps[0]))
      cb(scope)
    },
  }
  return { ctx, providers, tools, warnings, disposed,
    cleanup() { for (const fn of cleanups) if (typeof fn === 'function') fn() },
    get settingsCalls() { return settingsCalls },
    changeSettings(value) { settingsValue = value; watcher() },
  }
}

const host = fakeHost()
assert.doesNotThrow(() => plugin.apply(host.ctx, {}))
assert.equal(host.providers.length, 1)
assert.equal(host.providers[0].id, 'fusion')
assert.equal(host.providers[0].available(), true)
assert.match(host.warnings.join('\n'), /schemastery unavailable; settings schema skipped/)
assert.equal(host.settingsCalls, 0)
assert.deepEqual(host.tools.map(t => t.name), ['search_fusion_status', 'search_fusion_switch'])
for (const tool of host.tools) {
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.output.schema.type, 'string')
}
const [status, switchTool] = host.tools
assert.equal(switchTool.parameters.properties.fallback.items.type, 'string')
assert.match(await status.execute(), /primary engine: bing/)
assert.match(await status.execute(), /strategy: fusion/)
assert.match(await switchTool.execute({ primary: 'ddg', fallback: ['bing'] }), /ddg/)
assert.match(await status.execute(), /primary engine: ddg/)
assert.match(await switchTool.execute(), /ddg/)
await assert.rejects(switchTool.execute({ primary: 'not-an-engine' }), /unknown engine/)
await assert.rejects(switchTool.execute({ fallback: 'bing' }), /fallback must be an array/)
host.cleanup()
assert.deepEqual(host.disposed, ['search_fusion_status', 'search_fusion_switch'])
console.log('  ok  host-free import, provider, tools, validation and disposal')

for (const config of [null, false, 1, 'bad', { primary: [], fallback: {}, engineWeights: null }]) {
  const h = fakeHost()
  h.ctx.inject = () => { throw new Error('service unavailable') }
  assert.doesNotThrow(() => plugin.apply(h.ctx, config))
  assert.equal(h.providers.length, 1)
}
console.log('  ok  malformed config and unavailable optional services')

const originalFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('network forbidden in host-load test') }
const observedKeys = []
ADAPTERS.set('__stub__', {
  id: '__stub__',
  async search(_query, options) {
    observedKeys.push(options.apiKey)
    return { sources: [{ url: 'https://a.example/x', title: 'A' }, { url: 'https://b.example/y', title: 'B' }], truncated: false, engine: '__stub__' }
  },
})
// Capture AnySearch's key without calling its network adapter.
const anysearch = ADAPTERS.get('anysearch')
ADAPTERS.set('anysearch', ADAPTERS.get('__stub__'))
const envName = 'DSH_FUSION_TEST_KEY'
const previousEnv = process.env[envName]
try {
  const h = fakeHost()
  plugin.apply(h.ctx, { primary: '__stub__', fallback: [], strategy: 'sequential', cacheEnabled: false })
  const result = await h.providers[0].search({ query: 'x', maxResults: 5 })
  assert.equal(result.sources.length, 2)
  assert.match(result.content, /Fusion:/)
  assert.match(await h.tools[0].execute(), /engines=\[__stub__\]/)

  const keyed = fakeHost()
  let resolves = 0, key = 'first'
  keyed.ctx.get = name => name === 'credentials' ? { async resolve(ref) {
    assert.equal(ref, envName); resolves++; return { value: key }
  } } : undefined
  plugin.apply(keyed.ctx, { primary: 'anysearch', fallback: [], cacheEnabled: false, anysearchApiKeyEnv: envName })
  await keyed.providers[0].search({ query: 'x' })
  key = 'rotated'
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(resolves, 2)
  assert.deepEqual(observedKeys.slice(-2), ['first', 'rotated'])
  keyed.ctx.get = name => {
    if (name === 'credentials') throw new Error('absent')
    return { get() { return { value: 'launch-key' } } }
  }
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(observedKeys.at(-1), 'launch-key')
  process.env[envName] = 'env-key'
  keyed.ctx.get = () => { throw new Error('absent') }
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(observedKeys.at(-1), 'env-key')
} finally {
  globalThis.fetch = originalFetch
  ADAPTERS.delete('__stub__')
  ADAPTERS.set('anysearch', anysearch)
  if (previousEnv === undefined) delete process.env[envName]
  else process.env[envName] = previousEnv
}
console.log('  ok  offline search/report and same-search credential refresh/fallbacks')
noHostPackages.deregister()

// Exercise the settings-present branch without installing any host package.
const schemaStub = 'data:text/javascript,' + encodeURIComponent(`
  const schema = new Proxy(function () {}, { get: () => schema, apply: () => schema })
  export default schema
`)
const schemaHook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/schemastery'
      ? { url: schemaStub, shortCircuit: true } : next(specifier, context)
  },
})
try {
  const withSchema = await import('../lib/index.js?settings-test')
  const h = fakeHost()
  assert.doesNotThrow(() => withSchema.apply(h.ctx, {}))
  assert.equal(h.settingsCalls, 1)
  h.changeSettings({ primary: 'ddg', strategy: 'sequential' })
  assert.match(await h.tools[0].execute(), /primary engine: ddg/)
  assert.match(await h.tools[0].execute(), /strategy: sequential/)
} finally { schemaHook.deregister() }
console.log('  ok  optional settings.register/get/watch path (schema stub)')

for (const entry of await readdir(new URL('../lib/', import.meta.url), { recursive: true })) {
  if (!entry.endsWith('.js')) continue
  const source = await readFile(new URL(`../lib/${entry.replaceAll('\\', '/')}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]@deepseek-ai\//m, entry)
  assert.doesNotMatch(source, /\bimport\s+(?:[^;'"()]*?\s+from\s*)?['"]@deepseek-ai\//, entry)
}
console.log('  ok  lib contains no static host imports')
