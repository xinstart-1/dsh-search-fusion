/**
 * dsh-search-fusion — client half.
 *
 * Registers one settings page (`settings.section`, which is what puts a row in
 * the Settings navigation) for configuring the fusion provider: the engine
 * chain plus user-defined search engines.
 *
 * The module-loader contract, same as every DSH client plugin:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The shell calls `apply(ctx)` on the object the factory returns, and Babel/React
 * come from `require` — a bundle must NOT import them.
 *
 * Data flows over the host half's `/plugins/dsh-search-fusion/config` route;
 * nothing here talks to a search engine directly.
 *
 * UI principle: a search API is "an endpoint plus a key". Everything technical
 * (method, auth header, request body, JSON paths, MCP tool name) is derived from
 * a preset and hidden behind 「高级」 — the defaults are right for Tavily, and the
 * generic JSON-API case is still reachable without leaving the page.
 *
 * @module dsh-search-fusion/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-search-fusion',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/plugins/dsh-search-fusion'
    const SECTION_ID = 'dsh-search-fusion'
    const STYLE_ID = 'dsh-search-fusion-style'

    if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.sf-page{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px}',
        '.sf-hint{color:var(--dsw-text-tertiary,#8a8f98);font-size:12px;line-height:1.6;margin:0}',
        '.sf-field{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-border-subtle,#e6e8eb)}',
        '.sf-label{display:flex;flex-direction:column;gap:4px}',
        '.sf-label strong{font-weight:500}',
        '.sf-control{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
        '.sf-input,.sf-select{min-width:200px;padding:6px 10px;border:1px solid var(--dsw-border-default,#d0d3d8);border-radius:8px;background:var(--dsw-bg-base,#fff);color:var(--dsw-text-primary,#1f2328);font-size:13px;font-family:inherit}',
        '.sf-input.sf-wide{min-width:340px}',
        '.sf-btn{padding:6px 14px;border:1px solid var(--dsw-border-default,#d0d3d8);border-radius:8px;background:var(--dsw-bg-base,#fff);color:var(--dsw-text-primary,#1f2328);font-size:13px;cursor:pointer;font-family:inherit}',
        '.sf-btn:hover:not(:disabled){background:var(--dsw-bg-hover,#f2f4f6)}',
        '.sf-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.sf-btn.sf-primary{background:var(--dsw-accent,#247bbf);border-color:var(--dsw-accent,#247bbf);color:#fff}',
        '.sf-btn.sf-danger{color:#c0392b}',
        '.sf-card{border:1px solid var(--dsw-border-subtle,#e6e8eb);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-bg-subtle,#fafbfc)}',
        '.sf-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}',
        '.sf-grid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-text-secondary,#5b616b)}',
        '.sf-grid input,.sf-grid select{width:100%;padding:6px 9px;border:1px solid var(--dsw-border-default,#d0d3d8);border-radius:8px;background:var(--dsw-bg-base,#fff);color:var(--dsw-text-primary,#1f2328);font-size:13px;font-family:inherit}',
        '.sf-status{font-size:12px;padding:8px 10px;border-radius:8px;white-space:pre-wrap;line-height:1.6}',
        '.sf-status.sf-ok{background:rgba(39,174,96,.12);color:#1e8449}',
        '.sf-status.sf-err{background:rgba(192,57,43,.12);color:#c0392b}',
        '.sf-status.sf-warn{background:rgba(230,126,34,.12);color:#b9770e}',
        '.sf-empty{color:var(--dsw-text-tertiary,#8a8f98);font-size:12px;padding:6px 0}',
        '.sf-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(36,123,191,.12);color:#247bbf;white-space:nowrap}',
        '.sf-badge.sf-badge-warn{background:rgba(192,57,43,.12);color:#c0392b}',
        '.sf-advanced{font-size:12px;color:var(--dsw-text-secondary,#5b616b)}',
        '.sf-advanced summary{cursor:pointer;user-select:none;padding:4px 0}',
        '.sf-easy{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}',
        '.sf-easy label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-text-secondary,#5b616b)}',
        '.sf-easy .sf-span-2{grid-column:1 / -1}',
        '.sf-easy input,.sf-easy select{width:100%;padding:6px 9px;border:1px solid var(--dsw-border-default,#d0d3d8);border-radius:8px;background:var(--dsw-bg-base,#fff);color:var(--dsw-text-primary,#1f2328);font-size:13px;font-family:inherit}',
        '.sf-name{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 auto}',
        '.sf-name-input{width:100%;padding:4px 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-text-primary,#1f2328);font-size:15px;font-weight:600;font-family:inherit}',
        '.sf-name-input:hover{border-color:var(--dsw-border-subtle,#e6e8eb)}',
        '.sf-name-input:focus{outline:none;border-color:var(--dsw-accent,#247bbf);background:var(--dsw-bg-base,#fff)}',
        '.sf-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
        '.sf-btn.sf-btn-mini{padding:1px 8px;font-size:11px}',
        '.sf-badge.sf-badge-id{background:transparent;color:var(--dsw-text-tertiary,#8a8f98);padding-left:0}',
        '.sf-caret{flex:0 0 auto;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:var(--dsw-text-secondary,#5b616b);cursor:pointer;font-size:12px;border-radius:6px;padding:0}',
        '.sf-caret:hover{background:var(--dsw-bg-hover,#f2f4f6)}',
        '.sf-card-closed{padding:8px 14px;gap:4px}',
        '.sf-card-summary{font-size:12px;color:var(--dsw-text-tertiary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sf-textarea{width:100%;padding:8px 10px;border:1px solid var(--dsw-border-default,#d0d3d8);border-radius:8px;background:var(--dsw-bg-base,#fff);color:var(--dsw-text-primary,#1f2328);font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.5;resize:vertical}',
        '.sf-hint-err{color:#c0392b}',
      ].join('\n')
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------- */
    /* data                                                             */
    /* ---------------------------------------------------------------- */

    /** Only used until the host reports its own preset list. */
    const FALLBACK_PRESETS = [
      {
        id: 'tavily', label: 'Tavily', transport: 'rest',
        url: 'https://api.tavily.com/search', method: 'POST', apiKeyEnv: 'TAVILY_API_KEY',
        authHeader: 'Authorization: Bearer {key}',
        bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
        resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'content',
        mcpTool: '', mcpQueryArg: 'query', mcpMaxResultsArg: 'max_results',
      },
      {
        id: 'tavily-mcp', label: 'Tavily (MCP)', transport: 'mcp',
        url: 'https://mcp.tavily.com/mcp/', method: 'POST', apiKeyEnv: 'TAVILY_API_KEY',
        authHeader: 'Authorization: Bearer {key}',
        bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
        resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'content',
        mcpTool: 'tavily_search', mcpQueryArg: 'query', mcpMaxResultsArg: 'max_results',
      },
      {
        id: 'custom', label: '自定义 JSON API', transport: 'rest',
        url: '', method: 'GET', apiKeyEnv: '',
        authHeader: 'Authorization: Bearer {key}',
        bodyTemplate: '{"query":"{query}","max_results":{maxResults}}',
        resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'snippet',
        mcpTool: '', mcpQueryArg: 'query', mcpMaxResultsArg: 'max_results',
      },
    ]

    /** Field defaults for a brand-new row: preset fields minus the id/label pair. */
    function engineFromPreset(preset, id) {
      const p = preset ?? FALLBACK_PRESETS[2]
      return {
        id,
        label: p.id === 'custom' ? '' : p.label,
        preset: p.id,
        transport: p.transport ?? 'rest',
        url: p.url ?? '',
        method: p.method ?? 'GET',
        apiKeyEnv: p.apiKeyEnv ?? '',
        authHeader: p.authHeader ?? 'Authorization: Bearer {key}',
        resultsPath: p.resultsPath ?? 'results',
        urlField: p.urlField ?? 'url',
        titleField: p.titleField ?? 'title',
        snippetField: p.snippetField ?? 'snippet',
        bodyTemplate: p.bodyTemplate ?? '{"query":"{query}","max_results":{maxResults}}',
        mcpTool: p.mcpTool ?? '',
        mcpQueryArg: p.mcpQueryArg ?? 'query',
        mcpMaxResultsArg: p.mcpMaxResultsArg ?? 'max_results',
      }
    }

    /** Fields a preset owns; applying a preset rewrites exactly these. */
    const PRESET_FIELDS = [
      'transport', 'method', 'authHeader', 'resultsPath',
      'urlField', 'titleField', 'snippetField', 'bodyTemplate',
      'mcpTool', 'mcpQueryArg', 'mcpMaxResultsArg',
    ]

    /**
     * Name the engine from its endpoint.
     *
     * The page has no "engine type" control: the user pastes the URL they were
     * given and the name follows. Presets declare their hostnames (`match`), so
     * `api.tavily.com` becomes Tavily; anything else still gets a usable name
     * from the domain (`search.acme.io` -> Acme) instead of "自定义".
     *
     * @returns `{ preset, label }`; `preset` is undefined for an unknown host.
     */
    function inferFromUrl(url, presets) {
      let host = ''
      try {
        host = new URL(String(url ?? '').trim()).hostname.toLowerCase()
      } catch {
        host = ''
      }
      if (host !== '') {
        let matched
        for (const preset of presets) {
          for (const pattern of preset.match ?? []) {
            const stem = String(pattern).replace(/^\*\./, '').toLowerCase()
            if (stem !== '' && (host === stem || host.endsWith(`.${stem}`))) matched = preset
          }
        }
        if (matched !== undefined) return { preset: matched, label: matched.label }
      }
      return { preset: undefined, label: host === '' ? '' : humanizeHost(host) }
    }

    /** A name/id is "auto" while it still equals what the URL produced. */
    const isAutoName = (engine) => typeof engine._autoLabel === 'string' && engine.label === engine._autoLabel

    /** `api.search.acme.co.uk` -> `Acme`; `my-api.example` -> `Example`. */
    function humanizeHost(host) {
      const suffixes = new Set(['com', 'net', 'org', 'io', 'ai', 'cn', 'co', 'uk', 'dev', 'app', 'sh', 'so', 'me', 'us', 'jp', 'de'])
      const labels = String(host).split('.').filter((part) => part !== '')
      const meaningful = labels.filter((part) => !suffixes.has(part))
      const base = meaningful.length > 0 ? meaningful[meaningful.length - 1] : (labels[labels.length - 1] ?? '')
      const cleaned = base.replace(/^(api|search|www|mcp)+/i, '').replace(/[^a-z0-9-]/gi, '')
      const word = cleaned === '' ? base : cleaned
      return word.replace(/(^|[-_])([a-z0-9])/gi, (_m, sep, ch) => ch.toUpperCase())
    }

    /**
     * A legal engine id derived from a display name (`Acme Search` -> `acme-search`).
     * Returns '' when the name has nothing id-shaped in it (e.g. Chinese), so the
     * caller can keep whatever id it already had instead of falling back to a
     * meaningless one.
     */
    function idFromName(name) {
      return String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
    }

    /**
     * Follow an engine's id change into the roles that name it.
     *
     * A new row is made the primary engine under a placeholder id (`engine`) and
     * only gets its real id once the API address names it, so `primary` and
     * `fallback` - plain id strings held next to the rows - must be rewritten in
     * the same edit. Skipping that posted `primary: "engine"`, an id the host has
     * no engine for, and the whole save came back as "主引擎 engine 不可用" with no
     * visible cause: the select rendered a valid-looking option while the draft
     * still carried the dead id. The same applies to an id edited by hand in 高
     * 级, or cleared outright (then primary falls back to a built-in).
     *
     * @param base - the config the rows live in (`primary` / `fallback`).
     * @param oldId - the id the row had.
     * @param newId - the id the row has now; `''` means it was cleared.
     * @param fallbackPrimary - primary to use when the id was cleared.
     * @returns a patch for `primary` / `fallback`; `{}` when nothing named oldId.
     */
    function followIdChange(base, oldId, newId, fallbackPrimary) {
      const patch = {}
      if (oldId === undefined || oldId === '' || newId === undefined || newId === oldId) return patch
      if (base.primary === oldId) patch.primary = newId !== '' ? newId : (fallbackPrimary ?? '')
      const chain = Array.isArray(base.fallback) ? base.fallback : []
      if (chain.includes(oldId)) {
        // A cleared id leaves the chain rather than staying there as a dead name;
        // duplicates collapse so the same engine is not tried twice.
        const next = newId !== ''
          ? chain.map((id) => (id === oldId ? newId : id))
          : chain.filter((id) => id !== oldId)
        patch.fallback = [...new Set(next)]
      }
      return patch
    }

    /**
     * Render an engine as the MCP config users actually copy around, so the
     * field shows a real file body instead of one more blank to fill in:
     *   { "mcpServers": { "tavily": { "url": "https://mcp.tavily.com/mcp/" } } }
     */
    function formatMcpConfig(engine) {
      const name = (engine.id || engine.label || 'engine').trim() || 'engine'
      const server = { url: engine.url ?? '' }
      const authHeader = String(engine.authHeader ?? '').trim()
      const match = /^([^:\s]+)\s*:\s*([\s\S]*)$/.exec(authHeader)
      if (match !== null && match[2].includes('{key}')) {
        server.headers = { [match[1]]: match[2].trim() }
      }
      return JSON.stringify({ mcpServers: { [name]: server } }, null, 2)
    }

    /**
     * Read either pasted MCP config or a bare endpoint URL.
     *
     * Accepts the shapes people actually have on hand:
     *   { "mcpServers": { "tavily": { "url": "...", "headers": {...} } } }
     *   { "url": "..." }            (one server, no wrapper)
     *   https://mcp.tavily.com/mcp/ (plain URL)
     *
     * @returns null while the JSON is still incomplete; otherwise
     *          `{ url, name, authHeader?, unsupported? }`.
     */
    function parseMcpConfig(text) {
      const body = String(text ?? '').trim()
      if (body === '' || !body.startsWith('{')) return null
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        return null // still typing
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

      let name = ''
      let server = parsed
      if (parsed.mcpServers !== null && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
        const entries = Object.entries(parsed.mcpServers)
        if (entries.length === 0) return null
        name = String(entries[0][0])
        server = entries[0][1] ?? {}
      }
      if (server === null || typeof server !== 'object') return null

      // stdio servers are out of scope: this plugin speaks streamable HTTP only.
      if (typeof server.url !== 'string' && typeof server.command === 'string') {
        return { unsupported: '只支持 HTTP/SSE 的 MCP（配置里有 url）；stdio（command/args）不支持' }
      }
      const url = typeof server.url === 'string' ? server.url.trim() : ''
      const headers = server.headers !== null && typeof server.headers === 'object' && !Array.isArray(server.headers)
        ? server.headers
        : {}
      let authHeader
      for (const [headerName, raw] of Object.entries(headers)) {
        if (typeof raw !== 'string') continue
        if (!/^(authorization|x-api-key|api-key)$/i.test(headerName)) continue
        // `Bearer <token>` in the config describes the same credential the Key
        // field stores, so keep the header shape and let {key} fill the token.
        const bearer = /^Bearer\s+\S+$/i.test(raw.trim())
        authHeader = `${headerName}: ${bearer ? 'Bearer {key}' : '{key}'}`
        break
      }
      return { url, name, authHeader }
    }

    async function request(path, init) {
      const response = await fetch(ROUTE + path, { credentials: 'same-origin', ...(init ?? {}) })
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}: response was not JSON`)
      }
      if (!response.ok || body.ok !== true) {
        // A rejected save lists every item it refused; keeping only the summary
        // would leave the user guessing which row is wrong.
        const details = Array.isArray(body?.details) && body.details.length > 0
          ? `\n· ${body.details.join('\n· ')}`
          : ''
        throw new Error(String(body?.error ?? `HTTP ${response.status}`) + details)
      }
      return body.value
    }

    const fetchConfig = () => request('/config')
    const saveConfig = (patch) => request('/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    })

    /**
     * Placeholder shown in a key field whose secret already lives in DSH
     * credentials. The real value is never sent to the browser, so the field has
     * to show *something* — an empty box reads as "my key was deleted", which is
     * exactly the confusion this mask prevents.
     */
    const KEY_MASK = '••••••••••••'

    /** Transient per-engine key state; never written to config. */
    const keyField = (engine) => {
      if (typeof engine._key === 'string' && engine._key !== '') return engine._key
      return engine._keyConfigured === true ? KEY_MASK : ''
    }

    /** Whether this row's key field holds a value the user typed this session. */
    const keyEdited = (engine) => engine._keyDirty === true

    /**
     * Mirror of the host's `defaultKeyRef`: a legal credential reference
     * (`^[A-Za-z_][A-Za-z0-9_]*$`) derived from an engine id.
     */
    function deriveKeyRef(id) {
      const name = String(id ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      return name === '' ? '' : `DSH_SEARCH_${name}_KEY`
    }

    /* ---------------------------------------------------------------- */
    /* page                                                             */
    /* ---------------------------------------------------------------- */

    function SearchFusionSection() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      /**
       * Per-card open/closed state, keyed by engine id.
       *
       * Declared up here with the other hooks: React requires the hook order to
       * be identical on every render, and the loading/error branches below return
       * early. A hook declared after them runs on some renders and not others,
       * which throws and blanks the whole settings page.
       */
      const [openIds, setOpenIds] = React.useState(() => ({}))

      const load = React.useCallback(() => {
        setState({ phase: 'loading', data: null, error: null })
        fetchConfig()
          .then((value) => {
            setState({ phase: 'ready', data: value, error: null })
            setDraft(value.config)
          })
          .catch((error) => setState({ phase: 'error', data: null, error: String(error.message ?? error) }))
      }, [])

      React.useEffect(() => { load() }, [load])

      if (state.phase === 'loading') return h('div', { className: 'sf-page' }, h('p', { className: 'sf-hint' }, '正在读取配置…'))
      if (state.phase === 'error') {
        return h('div', { className: 'sf-page' },
          h('div', { className: 'sf-status sf-err' }, '读取失败：' + state.error),
          h('div', { className: 'sf-control' }, h('button', { className: 'sf-btn', onClick: load }, '重试')),
        )
      }

      const presets = Array.isArray(state.data.presets) && state.data.presets.length > 0
        ? state.data.presets
        : FALLBACK_PRESETS
      const keys = state.data.keys ?? {}
      /** Durable snapshot state reported by the host (see lib/store.js). */
      const recoveryInfo = state.data.store ?? {}
      // Only a host that reports it explicitly can store a pasted key; an older
      // host half ignores `secrets`, and silently losing a key is worse than
      // telling the user to set the ref by hand.
      const canStoreKeys = state.data.canStoreKeys === true
      const value = draft ?? state.data.config
      const patch = (next) => setDraft({ ...value, ...next })
      /**
       * Rows carry two page-local flags derived on every render:
       *   `_keyConfigured` — the host says this ref already holds a value, so the
       *                      key field renders a mask instead of an empty box;
       *   `_fromConfig`    — the row came from the saved config (vs. was added in
       *                      this session), which decides its initial fold state.
       * The host never sends the secret itself in either case.
       */
      const savedIds = new Set(
        (Array.isArray(state.data.config?.customEngines) ? state.data.config.customEngines : [])
          .map((engine) => engine.id)
          .filter(Boolean),
      )
      const engines = (Array.isArray(value.customEngines) ? value.customEngines : []).map((engine) => ({
        ...engine,
        _keyConfigured: keyEdited(engine)
          ? true
          : (engine._keyConfigured ?? keys[engine.id]?.configured === true),
        _fromConfig: engine._fromConfig ?? savedIds.has(engine.id),
      }))
      const allIds = [...state.data.builtins, ...engines.map((e) => e.id).filter(Boolean)]
      /**
       * The primary select must show the value it holds. A draft can still carry
       * an id the list does not contain (a row deleted elsewhere, a page left open
       * across a config change); rendering that against the bare list showed a
       * valid-looking "bing" while `primary` kept the dead id, so the save failed
       * with no visible cause. List the stray value and mark it, so the user can
       * simply pick another one.
       */
      const primaryOptions = value.primary === '' || allIds.includes(value.primary)
        ? allIds
        : [value.primary, ...allIds]
      /**
       * Ids typed into the fallback box that name no engine. The host rejects the
       * whole save for them; saying so next to the box beats letting the save be
       * the first thing to notice.
       */
      const unknownFallback = (value.fallback ?? []).filter((id) => !allIds.includes(id))

      /**
       * Card fold state helpers. The state itself is declared with the other
       * hooks at the top of the component (React needs a stable hook order).
       */
      const isCardOpen = (engine, index) => {
        const key = engine.id || `#${index}`
        if (key in openIds) return openIds[key] === true
        return engine._fromConfig !== true
      }
      const toggleCard = (engine, index) => {
        const key = engine.id || `#${index}`
        const next = !isCardOpen(engine, index)
        setOpenIds((current) => ({ ...current, [key]: next }))
      }
      /** Keep a card open while the user is editing it. */
      const pinOpen = (engine, index) => {
        const key = engine.id || `#${index}`
        setOpenIds((current) => (current[key] === true ? current : { ...current, [key]: true }))
      }

      /** One-line summary shown while a card is collapsed. */
      const summaryOf = (engine) => {
        const where = (engine.transport ?? 'rest') === 'mcp' ? 'MCP' : (engine.url || '未填地址')
        const keyed = engine._keyConfigured === true ? '已存 Key' : '缺 Key'
        return `${where} · ${keyed}`
      }

      /**
       * Apply a change to the engine list against the CURRENT draft rows, not the
       * array captured when the card was built. Two edits in one tick (or an edit
       * right after "添加引擎") would otherwise write back a stale list and drop
       * the other row's change.
       */
      const editEngines = (mutate) => {
        setDraft((current) => {
          const base = current ?? value
          const rows = Array.isArray(base.customEngines) ? base.customEngines : []
          const next = mutate(rows, base)
          return next === undefined ? base : { ...base, ...next }
        })
      }

      const updateEngine = (index, field, next) => {
        editEngines((rows) => ({
          customEngines: rows.map((row, i) => (i === index ? { ...row, [field]: next } : row)),
        }))
      }

      /** Pick a free id from a base name, so two Tavily rows cannot collide. */
      const freeId = (base, rows) => {
        const taken = new Set([...state.data.builtins, ...rows.map((e) => e.id).filter(Boolean)])
        if (!taken.has(base)) return base
        for (let n = 2; n < 100; n += 1) {
          const candidate = `${base}-${n}`
          if (!taken.has(candidate)) return candidate
        }
        return `${base}-${rows.length + 1}`
      }

      /**
       * The id an automatic row may use, derived from its URL / name / MCP server.
       *
       * Built-in ids are reserved by the host, so automatic ids must not collide
       * with them. `freeId` already treats built-ins as taken, so a reserved or
       * already-used derivation goes through it.
       *
       * @param derived - id the row's own name implies (already `idFromName`-ed).
       * @param rows - all custom-engine rows, the current one included.
       * @param index - the current row, which is excluded from "already used".
       * @returns an id the host accepts.
       */
      const freeAutoId = (derived, rows, index) => {
        const others = rows.filter((_row, i) => i !== index).map((row) => row.id).filter(Boolean)
        const clash = state.data.builtins.includes(derived) || others.includes(derived)
        return clash ? freeId(derived, rows) : derived
      }

      /**
       * Add a card.
       *
       * `transport: 'mcp'` opens it pre-filled with the standard `mcpServers`
       * fragment, because that is the shape MCP servers are handed out in — the
       * user pastes their own config over it instead of filling fields.
       *
       * The first custom engine takes over `primary` so a fresh install is
       * actually used; later rows never steal the primary slot.
       */
      const addEngine = (transport = 'rest') => {
        const blank = presets.find((p) => p.id === 'custom') ?? FALLBACK_PRESETS[2]
        const mcpPreset = presets.find((p) => p.id === 'tavily-mcp') ?? FALLBACK_PRESETS[1]
        editEngines((rows, base) => {
          const isMcp = transport === 'mcp'
          const id = freeId(isMcp ? mcpPreset.id : 'engine', rows)
          const seed = isMcp ? { ...engineFromPreset(mcpPreset, id) } : {
            ...engineFromPreset(blank, id),
            preset: 'custom',
            label: '',
            url: '',
            method: 'GET',
            transport: 'rest',
            apiKeyEnv: '',
          }
          const row = {
            ...seed,
            transport: isMcp ? 'mcp' : 'rest',
            _key: '',
            // No auto name yet: the URL has not been typed, so the label field is
            // free to be filled either by the user or by the pasted config.
            _autoLabel: '',
            // The id follows the auto name until the user edits it in 高级.
            _autoId: true,
          }
          const takeOver = state.data.builtins.includes(base.primary) || rows.length === 0
          return {
            customEngines: [...rows, row],
            ...(takeOver ? { primary: id, fallback: ['bing'] } : {}),
          }
        })
      }

      const removeEngine = (index) => {
        editEngines((rows, base) => {
          const removed = rows[index]
          const next = { customEngines: rows.filter((_row, i) => i !== index) }
          if (removed?.id) {
            // The row can be named in either list. A stale id left in the fallback
            // chain rejects the next save over an engine the user already deleted,
            // so the chain is cleaned whether or not the row was the primary.
            next.fallback = (base.fallback ?? []).filter((id) => id !== removed.id)
            // Do not leave `primary` pointing at an engine that no longer exists.
            if (base.primary === removed.id) {
              const remaining = next.customEngines.map((e) => e.id).filter(Boolean)
              next.primary = remaining[0] ?? state.data.builtins[0]
            }
          }
          return next
        })
      }

      /**
       * Typing an endpoint is what identifies the engine.
       *
       * The name and the technical defaults follow the URL: Tavily's host fills
       * in Tavily's preset, anything else gets its domain as the name. A name the
       * user typed by hand (one that no longer equals the auto value) is left
       * alone — only still-auto names keep following the URL.
       *
       * Moving off a preset also resets the technical fields that preset owned,
       * back to the generic JSON-API defaults. Keeping Tavily's POST body on an
       * unrelated endpoint would be a silent, wrong request.
       *
       * Why it also handles JSON: MCP servers are handed out as a `mcpServers`
       * fragment, which people paste into the first box they see. Detecting that
       * here turns the row into an MCP card instead of saving `{ "mcp...` as a URL.
       */
      const applyUrl = (index, url) => {
        const pasted = parseMcpConfig(url)
        if (pasted !== null) {
          applyMcpConfig(index, url)
          return
        }
        pinOpen(engines[index] ?? {}, index)
        editEngines((rows, base) => {
          const row = rows[index] ?? {}
          const { preset, label } = inferFromUrl(url, presets)
          const next = { url }
          if (preset !== undefined) {
            for (const field of PRESET_FIELDS) {
              if (typeof preset[field] === 'string' && preset[field] === '') continue
              if (preset[field] !== undefined) next[field] = preset[field]
            }
            next.preset = preset.id
            if (typeof preset.apiKeyEnv === 'string' && preset.apiKeyEnv !== '') {
              const refTaken = new Set(
                rows.filter((_r, i) => i !== index).map((r) => (r.apiKeyEnv ?? '').trim()).filter(Boolean),
              )
              if (!refTaken.has(preset.apiKeyEnv)) next.apiKeyEnv = preset.apiKeyEnv
            }
          } else {
            // Unknown host: back to a plain JSON API.
            const generic = presets.find((p) => p.id === 'custom') ?? FALLBACK_PRESETS[2]
            for (const field of PRESET_FIELDS) {
              if (generic[field] !== undefined) next[field] = generic[field]
            }
            next.preset = 'custom'
            next.transport = /\/mcp\/?($|\?)/i.test(url) ? 'mcp' : 'rest'
          }
          // Follow the URL only while the name is still automatic. `_autoId` is
          // deliberately NOT part of this test: it tracks the id alone, so a user
          // who renamed the row but never touched the id still keeps their name.
          const previousAuto = typeof row._autoLabel === 'string' ? row._autoLabel : undefined
          const stillAuto = row.label === undefined || row.label === '' || row.label === previousAuto
          if (stillAuto && label !== '') {
            next.label = label
            next._autoLabel = label
            // Keep the id in step too, but only while the id is itself automatic —
            // an id typed in 高级 is never overwritten.
            const derived = idFromName(label)
            if (derived !== '' && row._autoId !== false) {
              // Two rows on the same host would otherwise share one id (and one
              // key, one config, one collapse state); a built-in name is reserved.
              next.id = freeAutoId(derived, rows, index)
            }
          }
          const rowsNext = rows.map((r, i) => (i === index ? { ...r, ...next } : r))
          return {
            customEngines: rowsNext,
            ...followIdChange(base, row.id, rowsNext[index]?.id, state.data.builtins[0]),
          }
        })
      }

      const save = async () => {
        setSaving(true)
        setStatus(null)
        try {
          // Split the transient typed keys out of the rows: they travel as
          // `secrets` and are written to DSH credentials by the host, so the
          // profile file only ever holds the reference name. `_key`, `_autoLabel`
          // and `_autoId` / `_keyConfigured` are page-local bookkeeping and must
          // not be persisted.
          //
          // `_key` holds either a value the user typed now, or the display mask
          // of a key already in DSH credentials. Only the former is a secret to
          // store — sending the mask would overwrite the real key with dots.
          const secrets = {}
          const rows = engines.map((row) => {
            const {
              _key: typed, _autoLabel: _auto, _autoId: _autoIdFlag, _keyConfigured: _cfg,
              _keyDirty: dirty, _mcpText: _mcp, _mcpError: _mcpErr, ...rest
            } = row
            if (dirty === true && typeof typed === 'string' && typed !== '' && typed !== KEY_MASK && row.id) {
              secrets[row.id] = typed
            }
            return rest
          })
          if (!canStoreKeys && Object.keys(secrets).length > 0) {
            throw new Error('当前环境无法保存 API Key：请到 DSH 凭据里配置引用名（高级里的「Key 引用」），再重试')
          }
          const saved = await saveConfig({
            primary: value.primary,
            fallback: value.fallback,
            strategy: value.strategy,
            maxResults: value.maxResults,
            minResults: value.minResults,
            cacheEnabled: value.cacheEnabled,
            proxy: value.proxy,
            searxngInstances: value.searxngInstances,
            customEngines: rows,
            ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
          })
          // The host applies a save immediately (the next search uses it) and
          // keeps a durable copy next to the profile, so there is nothing left
          // to do on restart. If the recovery copy could not be written the
          // profile patch itself still succeeded — say so instead of pretending.
          const enginesSaved = Array.isArray(saved?.config?.customEngines) ? saved.config.customEngines.length : rows.length
          const suffix = saved?.persisted === false
            ? '\n（注意：本地恢复副本写入失败，profile 里已保存；若之后 profile 被重置需要重新添加引擎。）'
            : ''
          setStatus({
            kind: saved?.persisted === false ? 'warn' : 'ok',
            text: `已保存，立即生效。当前自定义引擎：${enginesSaved} 个。${suffix}`,
          })
          load()
        } catch (error) {
          setStatus({ kind: 'err', text: '保存失败：' + String(error.message ?? error) })
        } finally {
          setSaving(false)
        }
      }

      const row = (label, control, hint) => h('div', { className: 'sf-field' },
        h('div', { className: 'sf-label' }, h('strong', null, label), hint ? h('span', { className: 'sf-hint' }, hint) : null),
        h('div', { className: 'sf-control' }, control),
      )

      const field = (label, control, spanClass) => h('label', {
        key: label,
        className: spanClass ?? undefined,
      }, h('span', null, label), control)

      /**
       * "待保存" must mean *the user typed something this session that is not
       * yet stored* — never "a field has text in it". `keyField()` returns the
       * KEY_MASK for an already-saved secret, so testing it for non-empty text
       * made every configured engine read as pending forever. Only `_keyDirty`
       * (set by the input handler when the value differs from the mask) says a
       * fresh secret is waiting to be written.
       */
      const keyBadge = (engine) => {
        if (keyEdited(engine)) return h('span', { className: 'sf-badge' }, '待保存')
        if (keys[engine.id]?.configured === true) return h('span', { className: 'sf-badge' }, '已配置')
        if (keys[engine.id] !== undefined) return h('span', { className: 'sf-badge sf-badge-warn' }, '未配置')
        return null
      }

      /**
       * Apply a pasted MCP config.
       *
       * MCP servers are distributed as a JSON fragment (`mcpServers`), so the
       * field takes that text verbatim rather than asking for one more URL box.
       * Whatever is pasted is kept as the field's text so the user can keep
       * editing it; only a complete, parseable fragment updates the row.
       */
      const applyMcpConfig = (index, text) => {
        const parsed = parseMcpConfig(text)
        pinOpen(engines[index] ?? {}, index)
        editEngines((rows, base) => {
          const row = rows[index] ?? {}
          const next = { _mcpText: text, transport: 'mcp', preset: 'tavily-mcp' }
          if (parsed === null) {
            next._mcpError = ''
            return { customEngines: rows.map((r, i) => (i === index ? { ...r, ...next } : r)) }
          }
          if (parsed.unsupported !== undefined) {
            next._mcpError = parsed.unsupported
            return { customEngines: rows.map((r, i) => (i === index ? { ...r, ...next } : r)) }
          }
          if (parsed.url !== '') {
            next.url = parsed.url
            const inferred = inferFromUrl(parsed.url, presets)
            if (inferred.preset !== undefined) Object.assign(next, presetFieldsOf(inferred.preset))
          }
          if (parsed.authHeader !== undefined) next.authHeader = parsed.authHeader
          // Follow the name only while it is automatic, exactly like `applyUrl`.
          // The config's own server key ("tavily") is a JSON identifier, so prefer
          // the pretty name the endpoint infers ("Tavily"); fall back to the key.
          const stillAuto = (row.label ?? '') === '' || row.label === row._autoLabel
          const pretty = inferredLabel(parsed.url, presets)
          const serverName = pretty !== '' ? pretty : parsed.name
          // Two rows named "Tavily" would be indistinguishable on the page; the
          // transport suffix keeps the MCP one identifiable while still automatic.
          const transports = next.transport === 'mcp' || (inferredLabel(parsed.url, presets) !== '' && /\/mcp\b/i.test(parsed.url))
          const name = serverName !== '' && transports ? `${serverName} (MCP)` : serverName
          if (stillAuto && name !== '') {
            next.label = name
            next._autoLabel = name
            // A pasted config names its own server ("tavily"), which can collide
            // with a row that already exists — two rows sharing an id would also
            // share config, collapse state and key. Pick a free id instead.
            const derived = idFromName(name)
            if (derived !== '' && row._autoId !== false) {
              next.id = freeAutoId(derived, rows, index)
            }
          }
          next._mcpError = ''
          const rowsNext = rows.map((r, i) => (i === index ? { ...r, ...next } : r))
          return {
            customEngines: rowsNext,
            ...followIdChange(base, row.id, rowsNext[index]?.id, state.data.builtins[0]),
          }
        })
      }

      /** Preset fields as a bare patch object (no id/label). */
      const presetFieldsOf = (preset) => {
        const out = {}
        for (const field of PRESET_FIELDS) {
          if (typeof preset[field] === 'string' && preset[field] === '') continue
          if (preset[field] !== undefined) out[field] = preset[field]
        }
        out.preset = preset.id
        return out
      }

      const inferredLabel = (url, list) => inferFromUrl(url, list).label

      const advancedFields = (engine, index) => h('details', { className: 'sf-advanced' },
        h('summary', null, '高级（地址模板、JSON 路径、MCP 工具名）'),
        h('div', { className: 'sf-grid', style: { marginTop: '8px' } },
          field('id *', h('input', { value: engine.id ?? '', placeholder: 'tavily',
            onChange: (e) => editEngines((rows, base) => {
              const current = rows[index] ?? {}
              const nextId = e.target.value
              return {
                customEngines: rows.map((r, i) => (i === index ? { ...r, id: nextId, _autoId: false } : r)),
                ...followIdChange(base, current.id, nextId, state.data.builtins[0]),
              }
            }) })),
          field('连接方式', h('select', { value: engine.transport ?? 'rest',
            onChange: (e) => updateEngine(index, 'transport', e.target.value) },
            [['rest', 'REST / JSON'], ['mcp', 'MCP (JSON-RPC)']].map(([v, text]) => h('option', { key: v, value: v }, text)))),
          (engine.transport ?? 'rest') === 'mcp' ? null : field('方法', h('select', { value: engine.method ?? 'GET',
            onChange: (e) => updateEngine(index, 'method', e.target.value) },
            ['GET', 'POST'].map((m) => h('option', { key: m, value: m }, m)))),
          field('Key 引用（凭据/环境变量名）', h('input', { value: engine.apiKeyEnv ?? '', placeholder: 'TAVILY_API_KEY',
            onChange: (e) => updateEngine(index, 'apiKeyEnv', e.target.value) })),
          field('认证头模板', h('input', { value: engine.authHeader ?? '',
            onChange: (e) => updateEngine(index, 'authHeader', e.target.value) })),
          field('结果数组路径', h('input', { value: engine.resultsPath ?? '',
            onChange: (e) => updateEngine(index, 'resultsPath', e.target.value) })),
          field('URL 字段', h('input', { value: engine.urlField ?? '',
            onChange: (e) => updateEngine(index, 'urlField', e.target.value) })),
          field('标题字段', h('input', { value: engine.titleField ?? '',
            onChange: (e) => updateEngine(index, 'titleField', e.target.value) })),
          field('摘要字段', h('input', { value: engine.snippetField ?? '',
            onChange: (e) => updateEngine(index, 'snippetField', e.target.value) })),
          (engine.transport ?? 'rest') === 'mcp'
            ? field('MCP 工具名', h('input', { value: engine.mcpTool ?? '', placeholder: 'tavily_search',
                onChange: (e) => updateEngine(index, 'mcpTool', e.target.value) }))
            : field('POST 请求体模板', h('input', { value: engine.bodyTemplate ?? '',
                onChange: (e) => updateEngine(index, 'bodyTemplate', e.target.value) })),
          (engine.transport ?? 'rest') === 'mcp'
            ? field('MCP 查询参数名', h('input', { value: engine.mcpQueryArg ?? '', placeholder: 'query',
                onChange: (e) => updateEngine(index, 'mcpQueryArg', e.target.value) }))
            : null,
          (engine.transport ?? 'rest') === 'mcp'
            ? field('MCP 结果数参数名', h('input', { value: engine.mcpMaxResultsArg ?? '', placeholder: 'max_results',
                onChange: (e) => updateEngine(index, 'mcpMaxResultsArg', e.target.value) }))
            : null,
          // A duplicate or built-in id is rejected by the host as a whole-save
          // failure; name the clash under the field that owns it. Auto-derived ids
          // are made unique already, so this only fires for an id typed by hand.
          engine.id !== '' && state.data.builtins.includes(engine.id)
            ? h('p', { className: 'sf-hint sf-hint-err', style: { gridColumn: '1 / -1' } },
              `id "${engine.id}" 是内置引擎（${state.data.builtins.join(' / ')}）的名字，保存会被拒绝；` +
              `直接改叫 ${engine.id}-api 之类即可。若你只想用内置的 ${engine.id}，删掉这一行、在内置引擎处填 Key 更省事。`)
            : engine.id !== '' && engines.some((other, i) => i !== index && other.id === engine.id)
              ? h('p', { className: 'sf-hint sf-hint-err', style: { gridColumn: '1 / -1' } },
                `id "${engine.id}" 与其他引擎重复，保存会被拒绝；改成唯一的值。`)
              : null,
        ),
      )

      /**
       * Card layout: name (editable, auto-filled from the URL) → endpoint → key.
       *
       * There is no "engine type" control. The endpoint is the identity: pasting
       * `https://api.tavily.com/search` names the row Tavily and fills the
       * technical defaults; pasting any other host names it after the domain. The
       * name field stays editable, because a mirror or an internal endpoint often
       * needs a name the domain cannot express. Once the name is edited by hand it
       * stops following the URL (see `applyUrl`).
       */
      const engineCard = (engine, index) => {
        const isPrimary = engine.id !== '' && value.primary === engine.id
        const inFallback = (value.fallback ?? []).includes(engine.id)
        const role = isPrimary ? '主引擎' : (inFallback ? '回退' : '未启用')
        const autoNamed = isAutoName(engine)
        const isOpen = isCardOpen(engine, index)
        const enable = () => {
          if (engine.id === '') return
          if (isPrimary) return
          patch({ fallback: [...(value.fallback ?? []).filter((id) => id !== engine.id), engine.id] })
        }
        /**
         * The name field. `_autoLabel` keeps the last URL-derived name, so the
         * row stays "automatic" only while the label still equals it — typing
         * anything else is a deliberate rename and the URL must stop winning.
         */
        const rename = (next) => {
          editEngines((rows, base) => {
            const current = rows[index] ?? {}
            const patchRow = { label: next }
            // Keep the id in step while the id is still automatic, so the
            // primary/fallback dropdown never shows a stale "engine".
            const derived = idFromName(next)
            if (derived !== '' && current._autoId !== false) {
              // A name another row already owns, or a built-in engine's name, would
              // write an id the host rejects as a whole-save failure.
              patchRow.id = freeAutoId(derived, rows, index)
            }
            const rowsNext = rows.map((r, i) => (i === index ? { ...r, ...patchRow } : r))
            return {
              customEngines: rowsNext,
              ...followIdChange(base, current.id, rowsNext[index]?.id, state.data.builtins[0]),
            }
          })
        }
        const isMcp = (engine.transport ?? 'rest') === 'mcp'
        const mcpText = typeof engine._mcpText === 'string' ? engine._mcpText : formatMcpConfig(engine)
        const mcpError = typeof engine._mcpError === 'string' ? engine._mcpError : ''
        return h('div', { className: `sf-card${isOpen ? '' : ' sf-card-closed'}`, key: engine.id || index },
          h('div', { className: 'sf-card-head' },
            h('button', {
              className: 'sf-caret',
              title: isOpen ? '收起' : '展开',
              onClick: () => toggleCard(engine, index),
            }, isOpen ? '▾' : '▸'),
            h('div', { className: 'sf-name' },
              h('input', {
                className: 'sf-name-input',
                value: engine.label ?? '',
                placeholder: autoNamed ? '粘贴地址后自动识别' : '引擎名称',
                onChange: (e) => rename(e.target.value),
              }),
              h('span', { className: 'sf-badges' },
                h('span', { className: `sf-badge${role === '未启用' ? ' sf-badge-warn' : ''}` }, role),
                keyBadge(engine),
                engine.id ? h('span', { className: 'sf-badge sf-badge-id' }, `id: ${engine.id}`) : null,
                role === '未启用'
                  ? h('button', { className: 'sf-btn sf-btn-mini', onClick: enable }, '加入回退链')
                  : null)),
            h('button', { className: 'sf-btn sf-danger', onClick: () => removeEngine(index) }, '删除')),
          isOpen ? null : h('div', { className: 'sf-card-summary' }, summaryOf(engine)),
          isOpen ? h('div', { className: 'sf-easy' },
            isMcp
              ? field('MCP 配置（粘贴 mcpServers 片段）', h('textarea', {
                  className: 'sf-textarea sf-span-2',
                  rows: 7,
                  spellCheck: false,
                  value: mcpText,
                  placeholder: '{\n  "mcpServers": {\n    "tavily": {\n      "url": "https://mcp.tavily.com/mcp/"\n    }\n  }\n}',
                  onChange: (e) => applyMcpConfig(index, e.target.value),
                }), 'sf-span-2')
              : field('API 地址',
                  h('input', {
                    value: engine.url ?? '',
                    placeholder: 'https://api.tavily.com/search',
                    onChange: (e) => applyUrl(index, e.target.value),
                  }), 'sf-span-2'),
            mcpError !== ''
              ? h('p', { className: 'sf-hint sf-hint-err', style: { gridColumn: '1 / -1' } }, mcpError)
              : null,
            field('API Key', h('input', {
              type: 'password',
              autoComplete: 'off',
              // A stored key renders as dots, never as an empty box: "empty"
              // reads as "my key was deleted", the exact thing users reported.
              value: keyField(engine),
              placeholder: canStoreKeys ? '粘贴 API Key' : '该环境无法保存凭据，请在高级里填引用名',
              onChange: (e) => {
                const typed = e.target.value
                editEngines((rows) => ({
                  customEngines: rows.map((r, i) => (i === index
                    // Replacing (not appending to) the mask is what the user
                    // means when they start typing over it.
                    ? { ...r, _key: typed, _keyDirty: typed !== '' }
                    : r)),
                }))
              },
            }), 'sf-span-2'),
          ) : null,
          isOpen ? h('p', { className: 'sf-hint' },
            canStoreKeys
              ? 'Key 存进 DSH 凭据，配置文件里只留引用名，不回显明文。'
              : '当前环境没有 credentials 服务：请在 DSH 凭据或环境变量里配好 Key 引用。') : null,
          isOpen ? advancedFields(engine, index) : null,
        )
      }

      return h('div', { className: 'sf-page' },
        h('p', { className: 'sf-hint' },
          '搜索融合：先查主引擎，结果不足才继续查回退链。每次搜索会在结果里报告实际开销。'),

        // Reported by the host when the profile patch had lost settings and the
        // durable snapshot had to restore them (see lib/store.js). The user
        // pressing 保存 once writes the restored values back into the profile.
        Array.isArray(recoveryInfo?.recovered) && recoveryInfo.recovered.length > 0
          ? h('div', { className: 'sf-status sf-warn' },
            `检测到 profile 配置里缺少：${recoveryInfo.recoveredLabels.join('、')}。`
            + '已从本地恢复副本载入，页面显示的就是恢复后的值；点「保存」可重新写回 profile。')
          : null,

        row('主引擎 primary',
          h('select', { className: 'sf-select', value: value.primary, onChange: (e) => patch({ primary: e.target.value }) },
            primaryOptions.map((id) => h('option', { key: id, value: id },
              allIds.includes(id) ? id : `${id}（没有这个引擎，请改选）`)))),

        row('回退链 fallback',
          h('input', {
            className: 'sf-input sf-wide',
            value: (value.fallback ?? []).join(', '),
            placeholder: 'ddg, searxng',
            onChange: (e) => patch({ fallback: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }),
          }), unknownFallback.length === 0
            ? '逗号分隔，按顺序尝试'
            : `这些 id 没有对应的引擎，保存会被拒绝：${unknownFallback.join('、')}`),

        row('策略 strategy',
          h('select', { className: 'sf-select', value: value.strategy, onChange: (e) => patch({ strategy: e.target.value }) },
            ['sequential', 'fusion', 'always-fuse'].map((s) => h('option', { key: s, value: s }, s))),
          'fusion 默认；只在结果不足时才多查'),

        row('结果数 maxResults',
          h('input', { className: 'sf-input', type: 'number', min: 1, max: 50, value: value.maxResults,
            onChange: (e) => patch({ maxResults: Number(e.target.value) }) })),

        row('融合阈值 minResults',
          h('input', { className: 'sf-input', type: 'number', min: 1, max: 50, value: value.minResults,
            onChange: (e) => patch({ minResults: Number(e.target.value) }) }), '低于此数才继续查下一个引擎'),

        row('代理 proxy',
          h('input', { className: 'sf-input sf-wide', value: value.proxy ?? '', placeholder: 'http://127.0.0.1:7897',
            onChange: (e) => patch({ proxy: e.target.value }) }), 'DuckDuckGo / SearXNG 在大陆需要代理'),

        h('div', null,
          h('div', { className: 'sf-card-head', style: { marginBottom: '8px' } },
            h('div', { className: 'sf-label' },
              h('strong', null, '自定义搜索引擎'),
              h('span', { className: 'sf-hint' }, engines.length === 0
                ? '粘贴 API 地址和 Key 就能用；名称与技术参数按地址自动识别，也可手改。'
                : '每个引擎可单独收起；名称与技术参数按地址自动识别，也可手改。')),
            h('div', { className: 'sf-control' },
              h('button', { className: 'sf-btn', onClick: () => addEngine() }, '+ 添加引擎'))),
          engines.length === 0
            ? h('div', { className: 'sf-empty' }, '还没有自定义引擎。点「+ 添加引擎」，填一个 API Key 即可。')
            : engines.map((engine, index) => engineCard(engine, index)),
        ),

        // Where the durable copy lives: the one thing to look at (or delete) if
        // the user wants a clean slate instead of a recovery.
        typeof recoveryInfo.path === 'string' && recoveryInfo.path !== ''
          ? h('p', { className: 'sf-hint' },
            `本地恢复副本：${recoveryInfo.path}`
            + (typeof recoveryInfo.savedAt === 'string' && recoveryInfo.savedAt !== ''
              ? `（上次保存 ${new Date(recoveryInfo.savedAt).toLocaleString()}）`
              : '')
            + '。profile 配置被重置时，下次启动会从这里恢复。')
          : null,

        status === null ? null : h('div', {
          className: 'sf-status ' + (status.kind === 'ok' ? 'sf-ok' : status.kind === 'warn' ? 'sf-warn' : 'sf-err'),
        }, status.text),

        h('div', { className: 'sf-control', style: { justifyContent: 'flex-end' } },
          h('button', { className: 'sf-btn', onClick: load, disabled: saving }, '放弃修改'),
          h('button', { className: 'sf-btn sf-primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* registration                                                     */
    /* ---------------------------------------------------------------- */

    return {
      name: 'dsh-search-fusion-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 60,
          label: '搜索融合',
        }, SearchFusionSection))
      },
    }
  },
})
