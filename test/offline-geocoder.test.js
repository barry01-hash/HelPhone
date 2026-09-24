import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  searchCities,
  searchCitiesSync,
  loadCityDataset,
  isOffline,
  clearGeocoderCache,
} from '../src/lib/geocoder.ts'

describe('offline geocoder (#518)', () => {
  const originalFetch = globalThis.fetch
  const originalOnLine = Object.getOwnPropertyDescriptor(navigator, 'onLine')

  beforeEach(() => {
    clearGeocoderCache()
    vi.restoreAllMocks()
    globalThis.fetch = vi.fn()
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => true,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalOnLine) {
      Object.defineProperty(navigator, 'onLine', originalOnLine)
    }
    vi.resetModules()
  })

  it('searchCitiesSync matches a well-known city by name', () => {
    const hits = searchCitiesSync('new york')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toMatchObject({
      id: 'us-new-york',
      text: 'New York',
      source: 'offline',
      properties: { offline: true },
    })
    expect(hits[0].center).toEqual([-74.006, 40.7128]) // [lng, lat]
    expect(hits[0].place_name).toContain('New York')
  })

  it('is typo-tolerant (fuzzy) via fuse.js', () => {
    const hits = searchCitiesSync('new yrok')
    expect(hits.some((h) => h.text === 'New York')).toBe(true)
  })

  it('matches country names and alternative names', () => {
    expect(searchCitiesSync('bombay').some((h) => h.id === 'in-mumbai')).toBe(true)
    expect(searchCitiesSync('japan').some((h) => h.id === 'jp-tokyo')).toBe(true)
  })

  it('limits results and returns none for an empty query', () => {
    expect(searchCitiesSync('', { limit: 3 })).toHaveLength(0)
    expect(searchCitiesSync('   ')).toHaveLength(0)
    expect(searchCitiesSync('a', { limit: 3 }).length).toBeLessThanOrEqual(3)
  })

  it('falls back to the embedded dataset when fetch fails entirely (offline)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const hits = await searchCities('london')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id === 'gb-london')).toBe(true)
  })

  it('honours navigator.onLine=false without touching the network fetch', async () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    })
    const hits = await searchCities('paris')
    expect(hits.some((h) => h.id === 'fr-paris')).toBe(true)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('loadCityDataset parses the bundled cities.json when online', async () => {
    const payload = JSON.parse(
      await import('node:fs').then((fs) =>
        fs.promises.readFile('public/data/cities.json', 'utf8'),
      ),
    )
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    })
    const dataset = await loadCityDataset()
    expect(dataset.length).toBe(payload.count)
    expect(dataset).toEqual(payload.cities)
  })

  it('reports offline status from navigator.onLine', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    })
    expect(isOffline()).toBe(true)
  })
})