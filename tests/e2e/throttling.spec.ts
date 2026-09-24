import { test, expect } from '@playwright/test'
import type { CDPSession, Page } from '@playwright/test'

/**
 * Network throttling matrix, driven through the Chrome DevTools Protocol.
 *
 * Chromium only: CDP `Network.emulateNetworkConditions` has no Firefox/WebKit
 * equivalent. Each profile's tests are tagged `[profile]` so CI can run one
 * matrix leg per profile with `--grep "\[2g\]"`.
 *
 * Throughput values follow Chrome DevTools' presets. Playwright/CDP take bytes
 * per second, so kbps * 1024 / 8.
 */
interface Profile {
  name: string
  downloadKbps: number
  uploadKbps: number
  latencyMs: number
}

const kbpsToBytesPerSec = (kbps: number) => (kbps * 1024) / 8

export const PROFILES: Profile[] = [
  { name: '2g', downloadKbps: 50, uploadKbps: 20, latencyMs: 500 },
  { name: '3g', downloadKbps: 400, uploadKbps: 400, latencyMs: 400 },
  { name: 'cap-500kbps', downloadKbps: 500, uploadKbps: 500, latencyMs: 50 },
]

async function throttle(cdp: CDPSession, p: Profile) {
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: p.latencyMs,
    downloadThroughput: kbpsToBytesPerSec(p.downloadKbps),
    uploadThroughput: kbpsToBytesPerSec(p.uploadKbps),
  })
}

async function setOffline(cdp: CDPSession, offline: boolean) {
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
}

/** Fetch from inside the page so the request goes through the emulated network. */
const timedFetch = (page: Page, url: string) =>
  page.evaluate(async (u) => {
    const start = performance.now()
    try {
      const res = await fetch(u, { cache: 'no-store' })
      const body = await res.arrayBuffer()
      return { ok: res.ok, bytes: body.byteLength, ms: performance.now() - start, error: null as string | null }
    } catch (e) {
      return { ok: false, bytes: 0, ms: performance.now() - start, error: (e as Error).name }
    }
  }, url)

test.describe('Network throttling matrix', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP network emulation is Chromium-only')

  for (const profile of PROFILES) {
    test.describe(`[${profile.name}]`, () => {
      test(`[${profile.name}] the throttle is actually applied to page requests`, async ({ page }) => {
        await page.goto('/')
        const cdp = await page.context().newCDPSession(page)
        await throttle(cdp, profile)

        const r = await timedFetch(page, '/')
        expect(r.ok).toBe(true)
        // Even a small document cannot beat the emulated round-trip latency.
        expect(r.ms).toBeGreaterThanOrEqual(profile.latencyMs * 0.8)
        // And it cannot arrive faster than the bandwidth cap allows (20% slack for timer jitter).
        const floorMs = (r.bytes / kbpsToBytesPerSec(profile.downloadKbps)) * 1000 * 0.8
        expect(r.ms).toBeGreaterThanOrEqual(floorMs)
      })

      test(`[${profile.name}] concurrent requests queue and all complete without failing`, async ({ page }) => {
        await page.goto('/')
        const cdp = await page.context().newCDPSession(page)
        await throttle(cdp, profile)

        const results = await Promise.all(Array.from({ length: 5 }, () => timedFetch(page, '/')))
        for (const r of results) {
          expect(r.error).toBeNull()
          expect(r.ok).toBe(true)
        }
      })

      test(`[${profile.name}] the app stays interactive after a throttled navigation`, async ({ page }) => {
        const cdp = await page.context().newCDPSession(page)
        await throttle(cdp, profile)
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 90_000 })
        await expect(page.locator('text=HelPhone').first()).toBeVisible({ timeout: 90_000 })
        // No offline banner while the connection is merely slow.
        await expect(page.getByRole('alert')).toHaveCount(0)
      })
    })
  }

  test.describe('[offline]', () => {
    test('[offline] shows the offline indicator and hides it again on reconnect', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('alert')).toHaveCount(0)

      const cdp = await page.context().newCDPSession(page)
      await setOffline(cdp, true)
      const banner = page.getByRole('alert').filter({ hasText: /offline/i })
      await expect(banner).toBeVisible()
      await expect(banner).toContainText('Cached data will be used')

      await setOffline(cdp, false)
      await expect(banner).toBeHidden()
    })

    test('[offline] requests fail fast instead of hanging, then recover', async ({ page }) => {
      await page.goto('/')
      const cdp = await page.context().newCDPSession(page)

      await setOffline(cdp, true)
      const failed = await timedFetch(page, '/')
      expect(failed.ok).toBe(false)
      expect(failed.error).toBe('TypeError')
      expect(failed.ms).toBeLessThan(5_000)

      await setOffline(cdp, false)
      const recovered = await timedFetch(page, '/')
      expect(recovered.ok).toBe(true)
    })

    test('[offline] a page loaded while offline never reports a false online state', async ({ page, context }) => {
      await page.goto('/')
      await context.setOffline(true)
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
      await expect(page.getByRole('alert').filter({ hasText: /offline/i })).toBeVisible()
    })
  })
})
