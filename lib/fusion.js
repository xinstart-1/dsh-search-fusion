/**
 * Result fusion: normalize URLs, merge sources across engines, and score them.
 *
 * The scoring model is deliberately explainable rather than clever. An agent
 * reading the fused result needs to know *why* a source ranked where it did:
 *
 *   score = engineWeight
 *         + agreementBonus      (how many engines returned this URL)
 *         + titleBonus          (has a title)
 *         + snippetBonus        (has a snippet)
 *
 * `agreementBonus` is the interesting term: a URL that two independent engines
 * both returned is more likely to be a real answer than one only a single engine
 * surfaced. It is weighted so agreement can outrank a slightly heavier engine,
 * but never so high that a single heavy engine's top hit gets buried.
 */

/** Canonical form used for dedup: drop hash, trailing slash, tracking params. */
export function canonicalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  url.hash = ''
  // Tracking parameters add nothing to identity and would defeat dedup.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|ref_|source$|spm$|from$|share_|fbclid$|gclid$)/i.test(key)) {
      url.searchParams.delete(key)
    }
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '')
  }
  // Normalize host case; keep the path case-sensitive.
  url.hostname = url.hostname.toLowerCase()
  return url.toString()
}

/** A readable host label for the rendered report. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Merge per-engine result lists into one ranked list.
 *
 * @param batches - one entry per engine that answered: `{ engine, sources }`
 *                 in the order the engines were tried (primary first).
 * @param engineWeights - optional weight per engine id (default 1).
 * @returns ranked sources plus per-URL provenance for the report.
 */
export function fuseResults(batches, { engineWeights = {}, maxResults = 10 } = {}) {
  /** @type {Map<string, { url: string, title?: string, snippet?: string, engines: string[], firstSeen: number, weight: number }>} */
  const merged = new Map()
  let order = 0

  for (const batch of batches) {
    for (const source of batch.sources ?? []) {
      const canonical = canonicalizeUrl(source.url)
      if (canonical.length === 0) continue
      const weight = typeof engineWeights[batch.engine] === 'number' ? engineWeights[batch.engine] : 1
      const existing = merged.get(canonical)
      if (existing === undefined) {
        merged.set(canonical, {
          url: source.url,
          ...source.title !== undefined ? { title: source.title } : {},
          ...source.snippet !== undefined ? { snippet: source.snippet } : {},
          engines: [batch.engine],
          firstSeen: order++,
          weight,
        })
        continue
      }
      // Same URL from another engine: keep the first (primary engine wins ties)
      // but fill in a title/snippet the first engine omitted.
      if (!existing.engines.includes(batch.engine)) existing.engines.push(batch.engine)
      existing.weight = Math.max(existing.weight, weight)
      if ((existing.title === undefined || existing.title.length === 0) && source.title !== undefined) {
        existing.title = source.title
      }
      if ((existing.snippet === undefined || existing.snippet.length === 0) && source.snippet !== undefined) {
        existing.snippet = source.snippet
      }
    }
  }

  const scored = [...merged.values()].map((item) => {
    const agreement = item.engines.length - 1
    const hasTitle = item.title !== undefined && item.title.length > 0
    const hasSnippet = item.snippet !== undefined && item.snippet.length > 0
    const score = item.weight
      + agreement * 1.5
      + (hasTitle ? 0.25 : 0)
      + (hasSnippet ? 0.25 : 0)
    return { ...item, score, agreement }
  })

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable tie-break: earlier discovery wins, so the primary engine's order
    // survives among equally-scored results.
    return a.firstSeen - b.firstSeen
  })

  const truncated = scored.length > maxResults
  const kept = scored.slice(0, maxResults)
  return {
    sources: kept.map((item) => ({
      url: item.url,
      ...item.title !== undefined ? { title: item.title } : {},
      ...item.snippet !== undefined ? { snippet: item.snippet } : {},
    })),
    details: kept.map((item) => ({
      url: item.url,
      host: hostOf(item.url),
      engines: item.engines,
      agreement: item.agreement,
      score: Math.round(item.score * 100) / 100,
    })),
    truncated,
    totalBeforeCap: scored.length,
  }
}

/**
 * Render a human/agent-readable header describing how the result was produced.
 * Kept out of `sources` so the structured result stays clean; the plugin puts it
 * in the provider's `content` field, which the official web_search tool surfaces.
 */
export function renderReport({ enginesTried, enginesAnswered, fused, cached, elapsedMs }) {
  const lines = []
  const answered = enginesAnswered.length === 0 ? 'none' : enginesAnswered.join(', ')
  lines.push(`Fusion: ${enginesTried.length} engine(s) queried (${enginesTried.join(', ')}); answered: ${answered}.`)
  if (fused.totalBeforeCap > fused.sources.length) {
    lines.push(`Merged ${fused.totalBeforeCap} unique sources, showing top ${fused.sources.length}.`)
  }
  const multi = fused.details.filter((item) => item.agreement > 0)
  if (multi.length > 0) {
    lines.push(`Cross-engine agreement: ${multi.length} source(s) returned by 2+ engines.`)
  }
  if (cached) lines.push('Served from the local query cache (no new engine request).')
  if (typeof elapsedMs === 'number') lines.push(`Elapsed ${elapsedMs} ms.`)
  return lines.join(' ')
}
