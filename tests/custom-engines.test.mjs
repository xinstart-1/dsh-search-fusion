/**
 * Offline tests for user-defined JSON search engines.
 *
 * A tiny local HTTP server stands in for a real API, so these tests exercise
 * the whole path (config -> adapter -> HTTP -> parsing -> fusion) with no
 * network and no host packages.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADAPTERS, BACKEND_IDS, backendIds, isBackendId,
  createCustomAdapter, normalizeCustomEngines, installCustomEngines,
  ENGINE_PRESETS, inferEngineFromUrl, engineIdFromName,
} from '../lib/backends.js'
import { FusionProvider } from '../lib/provider.js'
import * as plugin from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (name) => { checks += 1; console.log('  ok  ' + name) }

{
  assert.deepEqual(BACKEND_IDS, ['bing', 'ddg', 'ddg-lite', 'searxng'])
  const preset = ENGINE_PRESETS.find((item) => item.id === 'anysearch')
  assert.deepEqual(preset?.match, ['api.anysearch.com'])
  assert.equal(preset?.bodyTemplate, '{"query":"{query}","max_results":{maxResults}}')
  // The live endpoint wraps results: { code, message, request_id, data: { results } }.
  // `results` here would read one level too shallow and return nothing.
  assert.equal(preset?.resultsPath, 'data.results', 'AnySearch results live under data.results')
  assert.equal(preset?.method, 'POST', 'the search endpoint is POST, not GET')
  ok('built-ins are keyless and AnySearch is a REST preset')
}

{
  const config = plugin.resolveConfig({ primary: 'anysearch', anysearchApiKeyEnv: 'OLD_KEY' })
  assert.equal(config.primary, 'anysearch')
  assert.equal(config.customEngines[0].id, 'anysearch')
  assert.equal(config.customEngines[0].apiKeyEnv, 'ANYSEARCH_API_KEY')
  assert.equal('anysearchApiKeyEnv' in config, false)
  ok('legacy AnySearch selections migrate to the preset without retaining its old field')
}

/** Minimal fake Cordis ctx, same shape the host-load suite uses. */
function fakeHost() {
  const providers = []
  const tools = []
  const warnings = []
  const ctx = {
    web: { registerSearchProvider: (p) => providers.push(p) },
    logger: { warn: (m) => warnings.push(m), info: () => {} },
    get: () => undefined,
    inject: (deps, cb) => {
      cb({
        tools: { register: (t) => { tools.push(t); return () => {} } },
        settings: { register: () => ({ get: () => ({}), watch: () => ({}) }) },
        effect: (fn) => fn(),
      })
      return () => {}
    },
    effect: (fn) => fn(),
  }
  return { ctx, providers, tools, warnings }
}

/** Start a local JSON API; returns { baseUrl, requests, close, handler }. */
async function startServer(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      try { handler(req, res, body) }
      catch (error) { res.writeHead(500).end(String(error)) }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/* ------------------------------------------------------------------ */
console.log('\nnormalizeCustomEngines')

const normalized = normalizeCustomEngines([
  { id: 'myapi', label: 'My API', url: 'https://api.example.com/search', apiKeyEnv: 'MY_KEY' },
  { id: 'BAD ID', url: 'https://x.example' },            // invalid id
  { id: 'bing', url: 'https://x.example' },               // reserved
  { id: 'noUrl', url: 'not-a-url' },                     // invalid url
  { id: 'dup', url: 'https://a.example' },
  { id: 'dup', url: 'https://b.example' },               // duplicate
  { id: 'myapi', url: 'https://c.example' },             // duplicate of first
  null,
])
assert.equal(normalized.length, 2)
assert.equal(normalized[0].id, 'myapi')
assert.equal(normalized[0].method, 'GET')
assert.equal(normalized[0].resultsPath, 'results')
assert.equal(normalized[1].id, 'dup')
ok('filters invalid, reserved, duplicate and non-object rows')

assert.deepEqual(normalizeCustomEngines(undefined), [])
assert.deepEqual(normalizeCustomEngines({ nope: 1 }), [])
ok('non-array config yields empty list (never throws)')

/* ------------------------------------------------------------------ */
console.log('\ncreateCustomAdapter: GET + field mapping')

{
  const server = await startServer((req, res) => {
    json(res, { data: { items: [
      { link: 'https://result.one/x', heading: 'One', abstract: 'First result' },
      { link: 'https://result.two/y', heading: 'Two' },
    ] } })
  })
  const adapter = createCustomAdapter({
    id: 'getapi',
    url: `${server.baseUrl}/search?q={query}&n={maxResults}`,
    resultsPath: 'data.items',
    urlField: 'link',
    titleField: 'heading',
    snippetField: 'abstract',
  })
  const result = await adapter.search('hello world', { maxResults: 5 })
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].url, 'https://result.one/x')
  assert.equal(result.sources[0].title, 'One')
  assert.equal(result.sources[0].snippet, 'First result')
  assert.equal(result.engine, 'getapi')
  const q = new URL(server.requests[0].url, server.baseUrl).searchParams
  assert.equal(q.get('q'), 'hello world')
  assert.equal(q.get('n'), '5')
  ok('GET with {query}/{maxResults} placeholders + nested resultsPath + field aliases')
  await server.close()
}

/* ------------------------------------------------------------------ */
console.log('\ncreateCustomAdapter: POST + auth header + template')

{
  const server = await startServer((req, res, body) => {
    if (req.headers['x-api-key'] !== 'secret-123') { json(res, { error: 'no key' }, 401); return }
    const parsed = JSON.parse(body)
    json(res, { results: [{ url: 'https://post.result/p', title: parsed.q, content: 'snippet' }] })
  })
  const adapter = createCustomAdapter({
    id: 'postapi',
    url: `${server.baseUrl}/v1/search`,
    method: 'POST',
    apiKeyEnv: 'POST_KEY',
    authHeader: 'X-API-Key: {key}',
    bodyTemplate: '{"q":"{query}","limit":{maxResults}}',
    snippetField: 'content',
  })
  const result = await adapter.search('needle', { maxResults: 3, apiKey: 'secret-123' })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].title, 'needle')
  assert.equal(result.sources[0].snippet, 'snippet')
  assert.equal(server.requests[0].method, 'POST')
  assert.equal(server.requests[0].headers['x-api-key'], 'secret-123')
  assert.equal(JSON.parse(server.requests[0].body).limit, 3)
  ok('POST body template + custom auth header + snippet fallback')

  await assert.rejects(
    () => adapter.search('needle', { maxResults: 3, apiKey: '' }),
    /requires a credential/,
  )
  ok('missing key fails clearly instead of leaking an unauthenticated call')
  await server.close()
}

/* ------------------------------------------------------------------ */
console.log('\ncreateCustomAdapter: error handling')

{
  const server = await startServer((_req, res) => json(res, { message: 'slow down' }, 429))
  const adapter = createCustomAdapter({ id: 'rate', url: `${server.baseUrl}/s` })
  await assert.rejects(() => adapter.search('x', { maxResults: 5 }), /HTTP 429/)
  ok('non-2xx reports the status code')
  await server.close()
}
{
  const server = await startServer((_req, res) => { res.writeHead(200); res.end('<html>not json</html>') })
  const adapter = createCustomAdapter({ id: 'html', url: `${server.baseUrl}/s` })
  await assert.rejects(() => adapter.search('x', { maxResults: 5 }), /did not return valid JSON/)
  ok('non-JSON response fails with a clear message')
  await server.close()
}
{
  const server = await startServer((_req, res) => json(res, { answer: 'just text' }))
  const adapter = createCustomAdapter({ id: 'nores', url: `${server.baseUrl}/s` })
  await assert.rejects(() => adapter.search('x', { maxResults: 5 }), /is not an array/)
  ok('missing results array fails with a clear message')
  await server.close()
}

/* ------------------------------------------------------------------ */
console.log('\ninstallCustomEngines: dynamic registry')

assert.ok(!isBackendId('dyn1'))
const dispose = installCustomEngines([
  { id: 'dyn1', url: 'https://one.example/s' },
  { id: 'dyn2', url: 'https://two.example/s' },
  { id: 'dyn1', url: 'https://dup.example/s' },
])
assert.ok(isBackendId('dyn1'))
assert.ok(isBackendId('dyn2'))
assert.ok(backendIds().includes('dyn1'))
assert.ok(ADAPTERS.has('dyn2'))
assert.equal(BACKEND_IDS.includes('dyn1'), false) // frozen built-in list stays stable
ok('custom ids become valid engines; built-in BACKEND_IDS stays frozen')
dispose()
assert.ok(!isBackendId('dyn1'))
assert.ok(!ADAPTERS.has('dyn2'))
ok('disposer removes exactly the installed ids')

/* ------------------------------------------------------------------ */
console.log('\napply(): settings-configured engines are live')

{
  const server = await startServer((req, res) => {
    if (req.headers.authorization !== 'Bearer k-9') { json(res, { error: 'no' }, 403); return }
    json(res, { results: [
      { url: 'https://custom.result/a', title: 'A', snippet: 'alpha' },
      { url: 'https://custom.result/b', title: 'B', snippet: 'beta' },
    ] })
  })

  // Pretend the host resolved the credential for this engine.
  const host = fakeHost()
  host.ctx.get = (name) => name === 'credentials'
    ? { resolve: async (ref) => ref === 'MY_ENGINE_KEY' ? { value: 'k-9' } : undefined }
    : undefined

  const disposePlugin = plugin.apply(host.ctx, {
    customEngines: [{
      id: 'mine', label: 'Mine', url: `${server.baseUrl}/search?q={query}`,
      apiKeyEnv: 'MY_ENGINE_KEY',
    }],
    primary: 'mine',
    fallback: [],
    strategy: 'sequential',
    cacheEnabled: false,
  })
  assert.equal(host.providers.length, 1)
  ok('apply() registers the provider with a custom primary (no throw)')

  const status = host.tools.find((t) => t.name === 'search_fusion_status')
  const statusText = await status.execute()
  assert.match(statusText, /custom engines: mine/)
  assert.match(statusText, /mine \(GET/)
  assert.match(statusText, /key: MY_ENGINE_KEY/)
  ok('status tool lists the custom engine without revealing the key')

  const sw = host.tools.find((t) => t.name === 'search_fusion_switch')
  assert.match(sw.parameters.properties.primary.description, /mine/)
  assert.match(await sw.execute({ primary: 'mine' }), /mine/)
  ok('switch tool accepts the custom id')

  const result = await host.providers[0].search({ query: 'x', maxResults: 5 })
  assert.equal(result.sources.length, 2)
  assert.match(result.content, /Fusion:/)
  assert.match(result.content, /mine/)
  ok('end-to-end search through the custom engine returns merged sources')
  await server.close()
  disposePlugin()
  assert.ok(!isBackendId('mine'))
  ok('plugin disposal unregisters its custom engines')
}

/* ------------------------------------------------------------------ */
console.log('\nengine presets: key + endpoint is enough')

{
  // Picking the Tavily preset must fill every technical field, so the row only
  // needs an endpoint and a key to be usable.
  const tavily = normalizeCustomEngines([{
    id: 'tavily',
    preset: 'tavily',
    url: 'https://api.tavily.com/search',
    apiKeyEnv: 'TAVILY_API_KEY',
  }])[0]
  assert.equal(tavily.transport, 'rest')
  assert.equal(tavily.method, 'POST')
  assert.equal(tavily.authHeader, 'Authorization: Bearer {key}')
  assert.equal(tavily.bodyTemplate, '{"query":"{query}","max_results":{maxResults}}')
  assert.equal(tavily.snippetField, 'content')
  assert.equal(tavily.label, 'Tavily')
  ok('preset fills method / auth header / body / JSON paths')

  // An explicit field on the row still wins over the preset.
  const overridden = normalizeCustomEngines([{
    id: 'tavily', preset: 'tavily', url: 'https://mirror.example/search', snippetField: 'description',
  }])[0]
  assert.equal(overridden.url, 'https://mirror.example/search')
  assert.equal(overridden.snippetField, 'description')
  ok('explicit row fields override the preset')

  const mcp = normalizeCustomEngines([{ id: 'tmcp', preset: 'tavily-mcp' }])[0]
  assert.equal(mcp.transport, 'mcp')
  assert.equal(mcp.method, 'POST', 'MCP is JSON-RPC over POST regardless of the method column')
  assert.equal(mcp.mcpTool, 'tavily_search')
  ok('MCP preset sets the transport, tool name and arg names')
}

{
  // End-to-end against a fake Tavily-shaped endpoint: the only two inputs are
  // the URL and the key.
  const server = await startServer((req, res, body) => {
    if (req.headers.authorization !== 'Bearer tvly-test') { json(res, { detail: 'unauthorized' }, 401); return }
    const parsed = JSON.parse(body)
    json(res, {
      query: parsed.query,
      results: [
        { url: 'https://tavily.result/1', title: 'One', content: 'snippet one', score: 0.9 },
        { url: 'https://tavily.result/2', title: 'Two', content: 'snippet two', score: 0.8 },
      ],
    })
  })
  const adapter = createCustomAdapter({
    id: 'tavily',
    preset: 'tavily',
    url: `${server.baseUrl}/search`,
    apiKeyEnv: 'TAVILY_API_KEY',
  })
  const result = await adapter.search('quantum', { maxResults: 5, apiKey: 'tvly-test' })
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].snippet, 'snippet one')
  const sent = JSON.parse(server.requests[0].body)
  assert.equal(sent.query, 'quantum')
  assert.equal(sent.max_results, 5)
  assert.equal(server.requests[0].headers.authorization, 'Bearer tvly-test')
  ok('Tavily preset round-trips: url + key only')
  await server.close()
}

/* ------------------------------------------------------------------ */
console.log('\nMCP transport (initialize -> tools/call)')

{
  const calls = []
  const server = await startServer((req, res, body) => {
    const payload = JSON.parse(body)
    calls.push({ payload, headers: req.headers })
    if (payload.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } },
      }))
      return
    }
    if (payload.method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }
    if (payload.method === 'tools/call') {
      if (payload.params.name !== 'tavily_search') { json(res, { error: 'bad tool' }, 400); return }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ results: [{ url: 'https://mcp.result/a', title: 'A', content: 'alpha' }] }),
          }],
        },
      }))
      return
    }
    json(res, { error: 'unknown method' }, 400)
  })

  const adapter = createCustomAdapter({
    id: 'tmcp',
    preset: 'tavily-mcp',
    url: `${server.baseUrl}/mcp/`,
    apiKeyEnv: 'TAVILY_API_KEY',
  })
  const result = await adapter.search('needle', { maxResults: 4, apiKey: 'tvly-test' })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://mcp.result/a')
  assert.equal(result.sources[0].snippet, 'alpha')
  ok('MCP tool text payload is parsed with the same results pipeline')

  assert.equal(calls.length, 3)
  assert.equal(calls[0].payload.method, 'initialize')
  assert.equal(calls[0].headers.authorization, 'Bearer tvly-test')
  assert.equal(calls[1].payload.method, 'notifications/initialized')
  assert.equal(calls[2].payload.method, 'tools/call')
  assert.equal(calls[2].headers['mcp-session-id'], 'sess-1', 'session id from initialize is reused')
  assert.deepEqual(calls[2].payload.params.arguments, { query: 'needle', max_results: 4 })
  ok('initialize -> initialized -> tools/call with the negotiated session id')
  await server.close()
}

{
  // SSE-framed replies are the other half of the streamable-HTTP spec.
  const server = await startServer((req, res, body) => {
    const payload = JSON.parse(body)
    if (payload.method === 'tools/call') {
      const frame = JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: '{"results":[{"url":"https://sse.result/x","title":"X"}]}' }] },
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: message\ndata: ${frame}\n\n`)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } }))
  })
  const adapter = createCustomAdapter({ id: 'sse', preset: 'tavily-mcp', url: `${server.baseUrl}/mcp/` })
  const result = await adapter.search('x', { maxResults: 2, apiKey: 'tvly-test' })
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://sse.result/x')
  ok('SSE-framed JSON-RPC replies are decoded')
  await server.close()
}

{
  const server = await startServer((_req, res) => json(res, { error: 'nope' }, 401))
  const adapter = createCustomAdapter({ id: 'mcpbad', preset: 'tavily-mcp', url: `${server.baseUrl}/mcp/` })
  await assert.rejects(() => adapter.search('x', { maxResults: 2, apiKey: 'k' }), /MCP HTTP 401/)
  ok('MCP auth failures report the status instead of a JSON parse error')
  await server.close()
}

/* ------------------------------------------------------------------ */
console.log('\ninferEngineFromUrl: the URL names the engine')

{
  const cases = [
    ['https://api.tavily.com/search', 'tavily', 'Tavily'],
    ['https://mcp.tavily.com/mcp/', 'tavily-mcp', 'Tavily'],
    ['https://API.Tavily.com/search', 'tavily', 'Tavily'],
    ['https://search.acme.io/v1/search', undefined, 'Acme'],
    ['https://api.search.acme.co.uk/x', undefined, 'Acme'],
    ['https://my-api.example/s', undefined, 'Example'],
    ['', undefined, ''],
  ]
  for (const [url, presetId, label] of cases) {
    const got = inferEngineFromUrl(url)
    assert.equal(got.preset?.id, presetId, `preset for ${url}`)
    assert.equal(got.label, label, `label for ${url}`)
  }
  ok('known hosts map to their preset; unknown hosts become a domain name')
}

{
  // Path must never influence the match: only the hostname identifies an engine.
  assert.equal(inferEngineFromUrl('https://example.com/api.tavily.com/search').preset, undefined)
  // A subdomain of a preset host still matches.
  assert.equal(inferEngineFromUrl('https://eu.api.tavily.com/search').preset?.id, 'tavily')
  ok('matching is hostname-based, including subdomains')
}

{
  assert.equal(engineIdFromName('Acme Search'), 'acme-search')
  assert.equal(engineIdFromName('公司内部搜索'), '', 'non-latin names yield no id, so the old id is kept')
  assert.equal(engineIdFromName('Tavily'), 'tavily')
  ok('engineIdFromName derives a URL-safe id and never fabricates one')
}

/* ------------------------------------------------------------------ */
console.log('\nhost-free module contract')

assert.match(
  fs.readdirSync(path.join(here, '..', 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(here, '..', 'lib', f), 'utf8'))
    .join('\n'),
  /./,
)
for (const file of fs.readdirSync(path.join(here, '..', 'lib')).filter((f) => f.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(here, '..', 'lib', file), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]@deepseek-ai\//m, `${file} has a static host import`)
}
ok('lib/ contains no static @deepseek-ai imports')

console.log(`\n${checks} checks passed\n`)
