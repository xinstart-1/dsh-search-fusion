/**
 * Small in-memory LRU + TTL cache for search results.
 *
 * Why this exists: the whole point of the plugin is to *not* burn free-engine
 * quota. An agent that retries a query, or asks the same thing in two shapes,
 * should not hit the network twice. The cache is process-local and bounded so a
 * long session cannot grow it without limit.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200

export class SearchCache {
  /** @type {Map<string, { value: unknown, expiresAt: number }>} */
  #entries = new Map()
  #ttlMs
  #maxEntries
  #hits = 0
  #misses = 0

  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.#ttlMs = ttlMs
    this.#maxEntries = maxEntries
  }

  static key({ query, engines, maxResults }) {
    const normalized = String(query ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    return JSON.stringify([normalized, [...engines].sort(), maxResults])
  }

  get(key) {
    const hit = this.#entries.get(key)
    if (hit === undefined) {
      this.#misses += 1
      return undefined
    }
    if (hit.expiresAt <= Date.now()) {
      this.#entries.delete(key)
      this.#misses += 1
      return undefined
    }
    // Refresh recency: delete + re-set moves it to the end of the Map.
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    this.#hits += 1
    return hit.value
  }

  set(key, value) {
    if (this.#entries.has(key)) this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  clear() {
    this.#entries.clear()
  }

  stats() {
    return {
      size: this.#entries.size,
      hits: this.#hits,
      misses: this.#misses,
      ttlMs: this.#ttlMs,
      maxEntries: this.#maxEntries,
    }
  }
}
