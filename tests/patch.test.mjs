/**
 * The bundle patch is part of this package's contract with the host, and it is
 * easy to break in a way no unit test elsewhere notices.
 *
 * DSH's loader patch REPLACES the targeted row's whole `config` instead of
 * merging into it (see @deepseek-ai/cordis-plugin-include applyPatches). So
 * `- id: web` must restate EVERY key the host needs, not just the one this
 * plugin changes. 0.1.1 only set `searchProvider`, which dropped dsh-base's
 * `fetchProvider: http`; with two usable fetch providers registered the host
 * then threw WEB_PROVIDER_AMBIGUOUS ("multiple usable web providers are
 * registered") on every web_fetch. Replayed against the real bundle layers this
 * suite has verified the composed row carries both keys.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const text = await readFile(patchUrl, 'utf8')

// Strip comments so commented-out keys cannot satisfy an assertion.
const live = text
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const webRow = live.match(/^- id: web\n((?: {2,}.*\n?)*)/m)
assert.ok(webRow, 'cordis.patch.yml must patch the `web` row by id')

const webConfig = webRow[1]
assert.match(webConfig, /^\s+searchProvider: fusion$/m, 'the web row must select the fusion search provider')
assert.match(
  webConfig,
  /^\s+fetchProvider: \S+$/m,
  'the web row must restate fetchProvider: a loader patch replaces the whole config, ' +
    'so omitting it drops the host default and breaks web_fetch with WEB_PROVIDER_AMBIGUOUS',
)

const inserted = live.match(/^- insert:\n((?: {2,}.*\n?)*)/m)
assert.ok(inserted, 'cordis.patch.yml must insert the plugin row')
assert.match(inserted[1], /^\s+- id: dsh-search-fusion$/m, 'the inserted row needs an explicit id')
assert.match(inserted[1], /^\s+name: dsh-search-fusion$/m, 'the inserted row needs its package name')

// Guard: the inserted plugin row must not carry a `config` block. A loader patch
// replaces the whole config, and this bundle patch is re-applied on every start,
// so a config here overwrote the user's saved engines/primary/fallback at each
// restart (the page then showed "检测到 profile 配置里缺少…" and relied on the
// recovery snapshot). Schema defaults cover a fresh install; the profile patch
// must stay authoritative afterwards.
{
  const rowStart = inserted[1].indexOf('- id: dsh-search-fusion')
  const row = inserted[1].slice(rowStart)
  assert.doesNotMatch(row, /^ {2,}config:/m,
    'the inserted plugin row must not set config: it would replace the user settings on every start')
  assert.match(row, /^ {2,}name: dsh-search-fusion$/m, 'the row still needs its name for the loader')
}

console.log('  ok  bundle patch keeps web.fetchProvider alongside searchProvider')
console.log('  ok  bundle patch inserts the plugin row with an explicit id and name')
console.log('  ok  the inserted plugin row leaves the user config alone')
