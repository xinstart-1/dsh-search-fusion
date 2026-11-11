/**
 * Simulate the host's client-module loader against lib/client.js:
 * a fake window.__ModuleLoader__ captures the registration, and a fake
 * React/Cordis ctx exercises apply() + the settings.section registration.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (label) => { checks += 1; console.log('  ok  ' + label) }
const clientPath = path.join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

let captured = null
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) { captured = entry },
  },
}

// Minimal React stand-in: the page factory is only *created*, not mounted.
// useState returns the initial value the component passed, like real React.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require("${name}")`)
}

const mod = new Function('window', 'document', source)
mod(fakeWindow, { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild() {} } })

assert.ok(captured !== null, 'client bundle must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-search-fusion')
assert.equal(typeof captured.factory, 'function')
ok('bundle registers id + factory')

const plugin = captured.factory(fakeRequire)
assert.equal(typeof plugin.apply, 'function')
assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'))
ok('factory returns a Cordis plugin with slots injection')

// Drive apply() with a fake slots service.
const registrations = []
const ctx = {
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(ctx)

assert.equal(registrations.length, 1)
const [{ options, component }] = registrations
assert.equal(options.name, 'settings.section')
assert.equal(options.id, 'dsh-search-fusion')
assert.equal(typeof options.order, 'number')
assert.equal(typeof options.label, 'string')
assert.equal(typeof component, 'function')
ok('registers settings.section (the settings nav row) with id/order/label')

// The component must be renderable without throwing (no hooks state yet).
const tree = component({})
assert.equal(tree.type, 'div')
ok('section component renders a root element')

// Guard: no static host imports in the browser bundle either.
assert.doesNotMatch(source, /^\s*import\s+.*from\s+['"]@deepseek-ai\//m)
assert.doesNotMatch(source, /^\s*export\s+/m)
ok('client bundle is a plain script (no ESM import/export)')

// Guard: the settings page must not re-send the display mask as a secret, and
// must render a stored key as dots rather than an empty field.
assert.match(source, /KEY_MASK/, 'a stored key renders as a mask')
assert.match(source, /_keyDirty/, 'only a value typed this session is treated as a secret')
assert.match(source, /typed !== KEY_MASK/, 'the mask is never posted back as the key')
ok('stored keys render as a mask and are never re-posted as secrets')

// Guard: the "待保存" badge means a *typed, not yet stored* key. Judging it by
// `keyField(engine)` being non-empty was wrong because that helper returns the
// KEY_MASK for an already-saved secret — so every configured engine showed
// "待保存" forever. Only `_keyDirty` may drive the badge.
{
  const start = source.indexOf('const keyBadge =')
  assert.ok(start >= 0, 'keyBadge helper found')
  const body = source.slice(start, source.indexOf('\n      }', start))
  assert.match(body, /keyEdited\(engine\)/, 'the badge is driven by _keyDirty, not field text')
  assert.doesNotMatch(body, /keyField\(/, 'the badge must not read keyField(): the mask would read as pending')
  assert.doesNotMatch(body, /trim\(\)\s*!==\s*''/, 'a non-empty field is not proof of an unsaved secret')
}
ok('the 待保存 badge reflects a typed secret, not the display mask')

// Guard: the engine list folds per card (not as one whole list).
assert.match(source, /setOpenIds/, 'card fold state is held in React state')
assert.match(source, /收起/, 'the collapse control is labelled')
ok('settings page can fold each engine card on its own')
assert.match(source, /sf-card-closed/, 'a card has a collapsed visual state')
assert.match(source, /sf-caret/, 'a card has its own expand/collapse control')
assert.match(source, /pinOpen/, 'editing a card keeps it open')
ok('each engine card collapses independently')

// Guard: MCP is entered as a pasted config file, not one more blank field.
assert.match(source, /parseMcpConfig/, 'MCP config text is parsed')
assert.match(source, /mcpServers/, 'the mcpServers fragment is understood')
assert.match(source, /h\('textarea'/, 'MCP config is a textarea, not a single-line input')
assert.match(source, /formatMcpConfig/, 'an existing MCP row renders as config text')
ok('MCP is entered as mcpServers JSON, not a URL box')

// Guard: React hooks must all run before the component's early returns.
// A hook declared after `if (state.phase === 'loading') return ...` runs on some
// renders and not others, which throws and blanks the whole settings page — the
// exact failure this guard exists to catch.
{
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes('function SearchFusionSection('))
  assert.ok(start >= 0, 'component found')
  const end = lines.findIndex((line, i) => i > start && line.includes('/* registration'))
  assert.ok(end > start, 'component end found')
  const body = lines.slice(start, end)
  const earlyReturn = body.findIndex((line) => /^\s*if \(state\.phase === 'loading'\)/.test(line))
  assert.ok(earlyReturn >= 0, 'component has a loading early return')
  const lateHooks = body
    .map((line, i) => ({ line, i }))
    .filter((entry) => entry.i > earlyReturn && /\bReact\.(useState|useEffect|useCallback|useMemo|useRef|useReducer)\b/.test(entry.line))
  assert.deepEqual(
    lateHooks.map((entry) => entry.line.trim()),
    [],
    'no React hook may be declared after an early return',
  )
  // Every hook referenced in the body must also be declared there, or the render
  // throws a ReferenceError (a removed `useState` left its setter behind).
  for (const setter of [...new Set(source.match(/\bset[A-Z][A-Za-z]+\b/g) ?? [])]) {
    const declared = new RegExp(`\\b(?:const|let|var)\\s*\\[\\s*[^\\]]*${setter}`).test(source)
      || new RegExp(`\\b(?:const|let|var)\\s+${setter}\\b`).test(source)
    assert.ok(declared, `${setter} is used but never declared`)
  }
  ok('all React hooks precede the early returns, and every setter is declared')
}

// Guard: the host route the page calls exists in the host half.
const routes = fs.readFileSync(path.join(here, '..', 'lib', 'routes.js'), 'utf8')
assert.match(routes, /\/plugins\/dsh-search-fusion/)
assert.match(source, /\/plugins\/dsh-search-fusion/)
ok('client and host halves agree on the /plugins/dsh-search-fusion route')

// Guard: a save must not tell the user to restart. The host applies a save
// immediately and keeps a durable copy, so "重启后新引擎才会生效" was both a lie
// and the reason a silently dropped engine looked like a data loss.
{
  const start = source.indexOf('const saved = await saveConfig(')
  assert.ok(start >= 0, 'save handler found')
  const body = source.slice(start, source.indexOf('load()', start))
  assert.doesNotMatch(body, /重启/, 'the success path must not ask for a restart')
  assert.match(body, /立即生效/, 'the success path states that it already took effect')
  assert.match(body, /saved\?\.persisted === false/, 'a failed recovery copy is reported, not hidden')
}
ok('a save reports "effective now" and surfaces a failed recovery copy')

// Guard: a 400 from the host lists the rejected items; dropping `details`
// leaves the page saying only "保存失败" with no way to find the bad row.
{
  const start = source.indexOf('async function request(')
  assert.ok(start >= 0, 'request helper found')
  const body = source.slice(start, source.indexOf('\n    }', start))
  assert.match(body, /body\?\.details/, 'the error path reads the host detail list')
  assert.match(body, /join\(/, 'the details are joined into the message')
}
ok('a rejected save shows every rejected item, not just the summary')

// Guard: the recovery banner exists and reports what was restored.
assert.match(source, /recoveredLabels/, 'the page names what was recovered')
assert.match(source, /sf-warn/, 'the recovery banner has its own (warning) style')
assert.match(source, /本地恢复副本/, 'the page tells the user where the durable copy is')
ok('the settings page reports recovery state and the snapshot path')

console.log(`\n${checks} checks passed\n`)
