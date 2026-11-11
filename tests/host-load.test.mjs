import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { ADAPTERS } from '../lib/backends.js'
import { SNAPSHOT_FILENAME, writeSnapshot } from '../lib/store.js'

// The plugin reads a durable snapshot from the profile directory when the host
// provides no profileContext. Point every derivation at an empty temp dir so a
// developer machine's real settings (or the tool shell's own $DSH_PROFILE_DIR)
// never leak into these assertions.
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-fusion-host-home-'))
process.env.DSH_HOME = isolatedHome
process.env.DSH_PROFILE_DIR = join(isolatedHome, 'profiles', 'host-load')
delete process.env.DSH_PROFILE

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

function fakeHost(profileContext) {
  const providers = [], tools = [], warnings = [], cleanups = [], disposed = []
  let settingsCalls = 0, watcher, settingsValue = {}
  const ctx = {
    web: { registerSearchProvider(p) { providers.push(p) } },
    credentials: { async resolve() { return { value: undefined } } },
    logger: { warn(message) { warnings.push(message) }, info() {} },
    get(name) { return name === 'profileContext' ? profileContext : undefined },
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
const observedKeys = []
globalThis.fetch = (_url, options = {}) => {
  observedKeys.push(options.headers?.Authorization)
  // The live AnySearch endpoint answers `{ code, message, request_id, data: { results } }`,
  // and the preset reads resultsPath `data.results`.
  return new Response(JSON.stringify({ code: 0, data: { results: [{ url: 'https://a.example/x', title: 'A' }] } }), { status: 200 })
}
ADAPTERS.set('__stub__', {
  id: '__stub__',
  async search(_query, options) {
    observedKeys.push(options.apiKey)
    return { sources: [{ url: 'https://a.example/x', title: 'A' }, { url: 'https://b.example/y', title: 'B' }], truncated: false, engine: '__stub__' }
  },
})
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
  plugin.apply(keyed.ctx, {
    primary: 'anysearch', fallback: [], cacheEnabled: false,
    customEngines: [{ id: 'anysearch', preset: 'anysearch', url: 'https://api.anysearch.com/v1/search', apiKeyEnv: envName }],
  })
  await keyed.providers[0].search({ query: 'x' })
  key = 'rotated'
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(resolves, 2)
  assert.deepEqual(observedKeys.slice(-2), ['Bearer first', 'Bearer rotated'])
  keyed.ctx.get = name => {
    if (name === 'credentials') throw new Error('absent')
    return { get() { return { value: 'launch-key' } } }
  }
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(observedKeys.at(-1), 'Bearer launch-key')
  process.env[envName] = 'env-key'
  keyed.ctx.get = () => { throw new Error('absent') }
  await keyed.providers[0].search({ query: 'x' })
  assert.equal(observedKeys.at(-1), 'Bearer env-key')
} finally {
  globalThis.fetch = originalFetch
  ADAPTERS.delete('__stub__')
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

{
  // What a restart looks like after something renamed the profile patch away
  // (the desktop app's fatal-recovery flow does exactly that): the loader hands
  // the plugin a config without the user's engines, and the durable snapshot
  // has to put them back — otherwise "重启后引擎又没了" happens again.
  const profile = mkdtempSync(join(tmpdir(), 'dsh-fusion-recover-'))
  const saved = plugin.resolveConfig({
    primary: 'kept',
    fallback: ['bing'],
    proxy: 'http://127.0.0.1:7897',
    customEngines: [{ id: 'kept', preset: 'custom', url: 'https://x.example/s', apiKeyEnv: 'K_KEY' }],
  })
  assert.equal(writeSnapshot(join(profile, SNAPSHOT_FILENAME), saved), true)

  const h = fakeHost({ name: 'desktop', dir: profile })
  plugin.apply(h.ctx, {})
  assert.ok(ADAPTERS.has('kept'), 'the recovered engine must be registered for the next search')
  assert.match(h.warnings.join('\n'), /lost \[customEngines/)
  const report = await h.tools[0].execute()
  assert.match(report, /primary engine: kept/)
  assert.match(report, /custom engines: kept/)
  console.log('  ok  a wiped profile config is restored from the durable snapshot at load')
}

// Guard: the loader hands every `.volatile()` Config field over as a REFERENCE,
// not a value. Reading `config.primary` directly therefore yielded an object,
// every typeof check failed, and the plugin booted on its defaults (bing, no
// fallback, no custom engines) while the durable snapshot restored the engines
// on every start — the yellow "检测到 profile 配置里缺少：自定义搜索引擎、主引擎、
// 回退链" banner. Plain objects (route patches, snapshots, tests) must read the
// same way.
{
  const ref = (value) => ({ get: () => value })
  const resolved = plugin.resolveConfig({
    primary: ref('tavily'),
    fallback: ref(['bing', 'ddg']),
    strategy: ref('fusion'),
    maxResults: ref(10),
    minResults: ref(5),
    cacheEnabled: ref(true),
    engineTimeoutMs: ref(12_000),
    locale: ref('zh-CN'),
    proxy: ref(''),
    customEngines: ref([
      { id: 'tavily', preset: 'tavily', url: 'https://api.tavily.com/search', apiKeyEnv: 'TAVILY_API_KEY' },
    ]),
  })
  assert.equal(resolved.primary, 'tavily', 'a volatile primary must be unwrapped, not defaulted to bing')
  assert.deepEqual(resolved.fallback, ['bing', 'ddg'])
  assert.equal(resolved.maxResults, 10)
  assert.equal(resolved.cacheEnabled, true)
  assert.equal(resolved.customEngines.length, 1, 'volatile custom engines must survive')
  assert.equal(resolved.customEngines[0].id, 'tavily')
  // A Config object holding only references must resolve exactly like the same
  // values passed plainly, or the boot path and the save path disagree.
  const plain = plugin.resolveConfig({
    primary: 'tavily',
    fallback: ['bing', 'ddg'],
    strategy: 'fusion',
    maxResults: 10,
    minResults: 5,
    cacheEnabled: true,
    engineTimeoutMs: 12_000,
    locale: 'zh-CN',
    proxy: '',
    customEngines: [
      { id: 'tavily', preset: 'tavily', url: 'https://api.tavily.com/search', apiKeyEnv: 'TAVILY_API_KEY' },
    ],
  })
  assert.deepEqual(resolved, plain, 'references and plain values resolve identically')
  console.log('  ok  volatile Config references are unwrapped before use')
}

for (const entry of await readdir(new URL('../lib/', import.meta.url), { recursive: true })) {
  if (!entry.endsWith('.js')) continue
  const source = await readFile(new URL(`../lib/${entry.replaceAll('\\', '/')}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]@deepseek-ai\//m, entry)
  assert.doesNotMatch(source, /\bimport\s+(?:[^;'"()]*?\s+from\s*)?['"]@deepseek-ai\//, entry)
}
console.log('  ok  lib contains no static host imports')
