/**
 * Live check: run the plugin's own Tavily adapter against the real API.
 *
 * Reads the stored credential the same way the plugin does, so this exercises
 * the real request shape (POST body, auth header, JSON field mapping) rather
 * than a hand-written fetch.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createCustomAdapter, normalizeCustomEngine } from '../lib/backends.js'

const credentialsFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')
const text = fs.readFileSync(credentialsFile, 'utf8')
// `refs:` is a YAML flow mapping, so a value ends at a comma or the closing brace.
const match = /TAVILY_API_KEY:\s*([^,\s}]+)/.exec(text)
if (match === null) {
  console.log('TAVILY_API_KEY is not configured; nothing to test')
  process.exit(0)
}
const apiKey = match[1]
console.log(`key: ${apiKey.slice(0, 5)}... (${apiKey.length} chars)`)

const def = normalizeCustomEngine({
  id: 'tavily',
  preset: 'tavily',
  url: 'https://api.tavily.com/search',
  apiKeyEnv: 'TAVILY_API_KEY',
})
console.log(`engine: ${def.transport} ${def.method} ${def.url}`)
console.log(`paths:  results=${def.resultsPath} url=${def.urlField} title=${def.titleField} snippet=${def.snippetField}`)

const adapter = createCustomAdapter(def)
const startedAt = Date.now()
const result = await adapter.search('Tavily search API', { maxResults: 5, apiKey, timeoutMs: 20_000 })
console.log(`\nOK ${result.sources.length} sources in ${Date.now() - startedAt} ms (engine=${result.engine})`)
for (const [index, source] of result.sources.entries()) {
  console.log(` ${index + 1}. ${source.title ?? '(no title)'}`)
  console.log(`    ${source.url}`)
  console.log(`    ${(source.snippet ?? '').slice(0, 90)}...`)
}

const problems = []
if (result.sources.length === 0) problems.push('no sources returned')
if (result.sources.some((source) => !source.url?.startsWith('http'))) problems.push('a source has no absolute url')
if (result.sources.every((source) => (source.title ?? '') === '')) problems.push('no titles mapped')
if (result.sources.every((source) => (source.snippet ?? '') === '')) problems.push('no snippets mapped')
console.log(problems.length === 0 ? '\nadapter mapping: OK' : `\nadapter mapping problems: ${problems.join('; ')}`)
process.exitCode = problems.length === 0 ? 0 : 1
