/**
 * Offline tests for the durable config snapshot (lib/store.js).
 *
 * The property under test is the one users notice: after something wipes the
 * profile patch, the next boot still has their custom engines.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/index.js'
import {
  mergeRecoveredConfig, pickSnapshotConfig, readSnapshot, resolveStatePath,
  SNAPSHOT_FILENAME, writeSnapshot,
} from '../lib/store.js'

let checks = 0
const ok = (name) => { checks += 1; console.log('  ok  ' + name) }

const dir = mkdtempSync(join(tmpdir(), 'dsh-fusion-store-'))
const statePath = join(dir, SNAPSHOT_FILENAME)
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

const TAVILY = {
  id: 'tavily',
  label: 'Tavily',
  preset: 'tavily',
  transport: 'rest',
  url: 'https://api.tavily.com/search',
  method: 'POST',
  apiKeyEnv: 'TAVILY_API_KEY',
  authHeader: 'Authorization: Bearer {key}',
  resultsPath: 'results',
  urlField: 'url',
  titleField: 'title',
  snippetField: 'content',
  bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
  mcpTool: '',
  mcpQueryArg: 'query',
  mcpMaxResultsArg: 'max_results',
}

/* ------------------------------------------------------------------ */
console.log('\nresolveStatePath')

{
  assert.equal(resolveStatePath({ get: () => ({ name: 'desktop', dir: 'C:/profiles/desktop' }) }), join('C:/profiles/desktop', SNAPSHOT_FILENAME))
  ok('uses the launcher-provided profileContext.dir when present')

  const saved = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR }
  delete process.env.DSH_PROFILE_DIR
  process.env.DSH_HOME = 'C:/dshhome'
  delete process.env.DSH_PROFILE
  try {
    // A profile directory, never the home root: the snapshot must live next to
    // the cordis.patch.yml it backs up.
    assert.equal(resolveStatePath({ get: () => undefined }), join('C:/dshhome', 'profiles', 'desktop', SNAPSHOT_FILENAME))
    ok('falls back to $DSH_HOME/profiles/desktop for hosts without profileContext')

    process.env.DSH_PROFILE = 'dytest'
    assert.equal(resolveStatePath({ get: () => undefined }), join('C:/dshhome', 'profiles', 'dytest', SNAPSHOT_FILENAME))
    ok('honours $DSH_PROFILE inside $DSH_HOME')

    process.env.DSH_PROFILE_DIR = 'C:/elsewhere/profile'
    assert.equal(resolveStatePath({ get: () => undefined }), join('C:/elsewhere/profile', SNAPSHOT_FILENAME))
    ok('an explicit $DSH_PROFILE_DIR wins over $DSH_HOME')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // A throwing service must not take the plugin down.
  assert.match(resolveStatePath({ get: () => { throw new Error('gone') } }), /profiles[\\/]desktop[\\/]dsh-search-fusion\.state\.json$/)
  ok('a broken profileContext service still yields a usable path')
}

/* ------------------------------------------------------------------ */
console.log('\nread/write snapshot')

{
  const config = resolveConfig({ primary: 'tavily', customEngines: [TAVILY] })
  assert.equal(writeSnapshot(statePath, config, new Date('2026-11-11T04:00:00.000Z')), true)
  const raw = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.savedAt, '2026-11-11T04:00:00.000Z')
  assert.equal(raw.config.customEngines[0].id, 'tavily')
  ok('a save writes version, timestamp and the restorable fields')

  const back = readSnapshot(statePath)
  assert.equal(back.config.primary, 'tavily')
  assert.equal(back.config.customEngines[0].apiKeyEnv, 'TAVILY_API_KEY')
  ok('the snapshot round-trips')

  assert.ok(!JSON.stringify(readFileSync(statePath, 'utf8')).includes('Bearer tvly'), 'no secret values are kept')
  ok('the snapshot never contains a secret value, only the credential ref')
}

{
  writeFileSync(statePath, '{"version":1,"config":{"customEngines":"not-a-list"}}')
  assert.equal(readSnapshot(statePath), undefined)
  ok('a structurally wrong snapshot is ignored, not trusted')
}

{
  writeFileSync(statePath, 'not json at all')
  assert.equal(readSnapshot(statePath), undefined)
  ok('a corrupted snapshot is ignored')

  assert.equal(readSnapshot(join(dir, 'does-not-exist.json')), undefined)
  ok('a missing snapshot is simply "no recovery copy"')
}

{
  // A save must not leave a half-written file behind when the directory cannot
  // be created (read-only profile, permissions, ...).
  const blocker = join(dir, 'blocked')
  writeFileSync(blocker, 'a file where a directory is needed')
  assert.equal(writeSnapshot(join(blocker, 'state.json'), resolveConfig({})), false)
  ok('an unwritable location reports failure instead of throwing')
}

{
  const config = resolveConfig({
    proxy: 'http://127.0.0.1:7897',
    customEngines: [TAVILY],
  })
  const picked = pickSnapshotConfig({ ...config, apiKey: 'secret', apiKeyEnv: 'X' })
  assert.ok('customEngines' in picked)
  assert.equal(picked.proxy, 'http://127.0.0.1:7897')
  assert.ok(!('apiKey' in picked), 'unknown fields never enter the snapshot')
  ok('pickSnapshotConfig keeps the restorable fields only')
}

/* ------------------------------------------------------------------ */
console.log('\nmergeRecoveredConfig')

const defaults = resolveConfig({})

{
  const live = resolveConfig({}) // profile patch lost everything
  const snapshot = { version: 1, savedAt: '2026-11-11T04:00:00.000Z', config: { customEngines: [TAVILY], proxy: 'http://127.0.0.1:7897' } }
  const { config, recovered } = mergeRecoveredConfig({ current: live, snapshot, defaults })
  const resolved = resolveConfig(config)
  assert.equal(resolved.customEngines.length, 1)
  assert.equal(resolved.customEngines[0].id, 'tavily')
  assert.equal(resolved.proxy, 'http://127.0.0.1:7897')
  assert.deepEqual(recovered, ['customEngines', 'proxy'])
  ok('a wiped profile gets its engines and lost settings back')
}

{
  // Partial loss: one row survived, one did not. Only the missing one returns.
  const live = resolveConfig({ customEngines: [{ ...TAVILY }] })
  const snapshot = { config: { customEngines: [TAVILY, { ...TAVILY, id: 'second', url: 'https://x.example/s' }] } }
  const { config, recovered } = mergeRecoveredConfig({ current: live, snapshot, defaults })
  const resolved = resolveConfig(config)
  assert.deepEqual(resolved.customEngines.map((e) => e.id), ['tavily', 'second'])
  assert.deepEqual(recovered, ['customEngines'])
  ok('a partially dropped engine list is completed, not duplicated')
}

{
  // A value the user deliberately changed is never overwritten by the snapshot.
  const live = resolveConfig({ strategy: 'sequential', customEngines: [TAVILY] })
  const snapshot = { config: { strategy: 'fusion', customEngines: [TAVILY] } }
  const { config, recovered } = mergeRecoveredConfig({ current: live, snapshot, defaults })
  assert.equal(config.strategy, 'sequential')
  assert.deepEqual(recovered, [])
  ok('non-default values win over the snapshot')
}

{
  // What the user saves last is what comes back: an intentional empty engine
  // list produces an empty snapshot, so the next boot stays empty.
  writeSnapshot(statePath, resolveConfig({}), new Date('2026-11-11T05:00:00.000Z'))
  const snapshot = readSnapshot(statePath)
  const { config, recovered } = mergeRecoveredConfig({ current: resolveConfig({}), snapshot, defaults })
  assert.equal(resolveConfig(config).customEngines.length, 0)
  assert.deepEqual(recovered, [])
  ok('saving "no engines" is not reverted by the recovery step')
}

{
  const { recovered } = mergeRecoveredConfig({ current: defaults, snapshot: undefined, defaults })
  assert.deepEqual(recovered, [])
  ok('no snapshot means no recovery')
}

/* ------------------------------------------------------------------ */

cleanup()
console.log(`\n${checks} checks passed\n`)
