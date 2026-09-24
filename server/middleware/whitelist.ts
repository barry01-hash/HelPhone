/**
 * server/middleware/whitelist.ts — Dynamic IP-subnet / API-key whitelist.
 *
 * Verified emergency-service callers must never be throttled. Authorised
 * IPv4/IPv6 subnets (CIDR) and API keys live in Redis (or an in-memory store
 * when Redis isn't configured) so they can be changed at runtime through the
 * admin API without a redeploy. A matching request gets `req.bypassRateLimit`,
 * which the rate limiters honour.
 *
 * Security notes:
 *  - API keys are stored only as SHA-256 hashes; the plaintext is returned
 *    once, on creation.
 *  - The client IP comes from `req.ip`. Behind a proxy set TRUST_PROXY so
 *    Express resolves the real client address; otherwise the proxy IP is seen.
 *  - Store failures fail closed: no bypass, the normal limit applies.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import { getRedis } from '../lib/redis.js'
import type { RedisHashClient } from '../lib/redis.js'

export const SUBNETS_KEY = 'whitelist:subnets'
export const API_KEYS_KEY = 'whitelist:api-keys'
export const API_KEY_HEADER = 'x-api-key'
const SUBNET_CACHE_TTL_MS = 5_000

// ── IP / CIDR parsing ────────────────────────────────────────────────────────

export interface ParsedCidr {
  version: 4 | 6
  network: bigint
  prefix: number
}

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function parseIpv6(input: string): bigint | null {
  const s = input.split('%')[0] // strip zone id
  if (!s.includes(':')) return null
  let head = s
  let tail = ''
  const dbl = s.indexOf('::')
  if (dbl !== -1) {
    if (s.indexOf('::', dbl + 1) !== -1) return null
    head = s.slice(0, dbl)
    tail = s.slice(dbl + 2)
  }
  const toGroups = (part: string): string[] | null => (part === '' ? [] : part.split(':'))
  const headGroups = toGroups(head)
  const tailGroups = toGroups(tail)
  if (!headGroups || !tailGroups) return null

  // Embedded IPv4 in the final position (e.g. ::ffff:1.2.3.4)
  const all = dbl === -1 ? headGroups : tailGroups
  const last = all[all.length - 1]
  if (last && last.includes('.')) {
    const v4 = parseIpv4(last)
    if (v4 === null) return null
    all.splice(all.length - 1, 1, ((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16))
  }

  const total = headGroups.length + tailGroups.length
  if (dbl === -1 ? total !== 8 : total > 7) return null
  const groups = dbl === -1 ? headGroups : [...headGroups, ...Array(8 - total).fill('0'), ...tailGroups]

  let value = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    value = (value << 16n) | BigInt(parseInt(g, 16))
  }
  return value
}

/** Parse a textual IP; IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
export function parseIp(ip: string | undefined | null): { version: 4 | 6; value: bigint } | null {
  if (!ip) return null
  const s = ip.trim()
  const v4 = parseIpv4(s)
  if (v4 !== null) return { version: 4, value: v4 }
  const v6 = parseIpv6(s)
  if (v6 === null) return null
  if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn }
  return { version: 6, value: v6 }
}

export function parseCidr(input: string): ParsedCidr | null {
  const [addr, prefixStr, ...rest] = input.trim().split('/')
  if (rest.length > 0) return null
  const ip = parseIp(addr)
  if (!ip) return null
  const bits = ip.version === 4 ? 32 : 128
  let prefix = bits
  if (prefixStr !== undefined) {
    if (!/^\d{1,3}$/.test(prefixStr)) return null
    prefix = Number(prefixStr)
    if (prefix > bits) return null
  }
  const shift = BigInt(bits - prefix)
  return { version: ip.version, network: (ip.value >> shift) << shift, prefix }
}

export function formatCidr(c: ParsedCidr): string {
  if (c.version === 4) {
    const octets = [24n, 16n, 8n, 0n].map((s) => Number((c.network >> s) & 0xffn))
    return `${octets.join('.')}/${c.prefix}`
  }
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((c.network >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)
  )
  return `${groups.join(':')}/${c.prefix}`
}

export function ipInCidr(ip: string | undefined | null, cidr: ParsedCidr): boolean {
  const parsed = parseIp(ip)
  if (!parsed || parsed.version !== cidr.version) return false
  const shift = BigInt((cidr.version === 4 ? 32 : 128) - cidr.prefix)
  return parsed.value >> shift === cidr.network >> shift
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface SubnetEntry {
  cidr: string
  label: string
  createdAt: string
}

export interface ApiKeyEntry {
  id: string
  label: string
  createdAt: string
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export interface WhitelistStore {
  listSubnets(): Promise<SubnetEntry[]>
  addSubnet(cidr: string, label: string): Promise<SubnetEntry>
  removeSubnet(cidr: string): Promise<boolean>
  listApiKeys(): Promise<ApiKeyEntry[]>
  /** Registers a key by hash and returns its entry (plaintext is never stored). */
  addApiKey(plaintext: string, label: string): Promise<ApiKeyEntry>
  removeApiKey(id: string): Promise<boolean>
  hasApiKey(plaintext: string): Promise<boolean>
}

/** In-process hash implementing the same calls as ioredis, for dev and tests. */
export function createMemoryRedis(): RedisHashClient {
  const data = new Map<string, Map<string, string>>()
  const hash = (key: string) => {
    let h = data.get(key)
    if (!h) data.set(key, (h = new Map()))
    return h
  }
  return {
    async hset(key, field, value) {
      hash(key).set(field, value)
      return 1
    },
    async hget(key, field) {
      return hash(key).get(field) ?? null
    },
    async hdel(key, ...fields) {
      const h = hash(key)
      return fields.filter((f) => h.delete(f)).length
    },
    async hgetall(key) {
      return Object.fromEntries(hash(key))
    },
  }
}

/**
 * Store backing used by the server: Redis when REDIS_URL is set, otherwise a
 * single in-process hash. Resolved lazily so importing this module never
 * connects to anything.
 */
export function createDefaultRedisClient(): RedisHashClient {
  let backing: Promise<RedisHashClient> | undefined
  const resolve = () => (backing ??= getRedis().then((r) => r ?? createMemoryRedis()))
  return {
    hset: async (k, f, v) => (await resolve()).hset(k, f, v),
    hget: async (k, f) => (await resolve()).hget(k, f),
    hdel: async (k, ...f) => (await resolve()).hdel(k, ...f),
    hgetall: async (k) => (await resolve()).hgetall(k),
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function createWhitelistStore(redis: RedisHashClient): WhitelistStore {
  return {
    async listSubnets() {
      const all = await redis.hgetall(SUBNETS_KEY)
      return Object.entries(all).flatMap(([cidr, raw]) => {
        const meta = parseJson<{ label: string; createdAt: string }>(raw)
        return meta ? [{ cidr, label: meta.label, createdAt: meta.createdAt }] : []
      })
    },
    async addSubnet(cidr, label) {
      const parsed = parseCidr(cidr)
      if (!parsed) throw new Error(`Invalid CIDR: ${cidr}`)
      const canonical = formatCidr(parsed)
      const entry = { cidr: canonical, label, createdAt: new Date().toISOString() }
      await redis.hset(SUBNETS_KEY, canonical, JSON.stringify({ label, createdAt: entry.createdAt }))
      return entry
    },
    async removeSubnet(cidr) {
      const parsed = parseCidr(cidr)
      if (!parsed) return false
      return (await redis.hdel(SUBNETS_KEY, formatCidr(parsed))) > 0
    },
    async listApiKeys() {
      const all = await redis.hgetall(API_KEYS_KEY)
      return Object.values(all).flatMap((raw) => {
        const entry = parseJson<ApiKeyEntry>(raw)
        return entry ? [entry] : []
      })
    },
    async addApiKey(plaintext, label) {
      const hash = hashApiKey(plaintext)
      const entry: ApiKeyEntry = { id: hash.slice(0, 16), label, createdAt: new Date().toISOString() }
      await redis.hset(API_KEYS_KEY, hash, JSON.stringify(entry))
      return entry
    },
    async removeApiKey(id) {
      const all = await redis.hgetall(API_KEYS_KEY)
      const hash = Object.keys(all).find((h) => h.slice(0, 16) === id)
      return hash ? (await redis.hdel(API_KEYS_KEY, hash)) > 0 : false
    },
    async hasApiKey(plaintext) {
      return (await redis.hget(API_KEYS_KEY, hashApiKey(plaintext))) !== null
    },
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────

export type BypassRequest = Request & { bypassRateLimit?: boolean }

export function isWhitelisted(req: Request): boolean {
  return (req as BypassRequest).bypassRateLimit === true
}

export interface WhitelistMiddleware {
  (req: Request, res: Response, next: NextFunction): Promise<void>
  /** Drop the cached subnet list (called after admin changes). */
  invalidate(): void
}

export function createWhitelistMiddleware(
  store: WhitelistStore,
  { cacheTtlMs = SUBNET_CACHE_TTL_MS, now = Date.now }: { cacheTtlMs?: number; now?: () => number } = {}
): WhitelistMiddleware {
  let cache: { at: number; subnets: ParsedCidr[] } | null = null

  async function subnets(): Promise<ParsedCidr[]> {
    if (cache && now() - cache.at < cacheTtlMs) return cache.subnets
    const parsed = (await store.listSubnets()).flatMap((e) => {
      const c = parseCidr(e.cidr)
      return c ? [c] : []
    })
    cache = { at: now(), subnets: parsed }
    return parsed
  }

  const middleware = (async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if ((await subnets()).some((c) => ipInCidr(req.ip, c))) {
        ;(req as BypassRequest).bypassRateLimit = true
      } else {
        const key = req.headers[API_KEY_HEADER]
        if (typeof key === 'string' && key && (await store.hasApiKey(key))) {
          ;(req as BypassRequest).bypassRateLimit = true
        }
      }
    } catch (err) {
      // Fail closed: a store outage must not grant bypass.
      console.error('[whitelist] lookup failed, applying normal rate limit:', (err as Error).message)
    }
    next()
  }) as WhitelistMiddleware
  middleware.invalidate = () => {
    cache = null
  }
  return middleware
}

// ── Admin API ────────────────────────────────────────────────────────────────

function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Admin endpoints, mounted at /admin/whitelist. Guarded by a bearer token
 * (WHITELIST_ADMIN_TOKEN); with no token configured they respond 503 rather
 * than exposing an open management surface.
 */
export function createWhitelistAdminRouter({
  store,
  adminToken,
  onChange,
}: {
  store: WhitelistStore
  adminToken: string | undefined
  onChange?: () => void
}): Router {
  const router = express.Router()

  router.use((req, res, next) => {
    if (!adminToken) {
      res.status(503).json({ success: false, error: 'Whitelist admin API is not configured' })
      return
    }
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (!match || !tokenMatches(match[1], adminToken)) {
      res.status(401).json({ success: false, error: 'Unauthorized' })
      return
    }
    next()
  })

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res).catch(next)
    }

  router.get(
    '/',
    handle(async (_req, res) => {
      res.json({ success: true, subnets: await store.listSubnets(), apiKeys: await store.listApiKeys() })
    })
  )

  router.post(
    '/subnets',
    handle(async (req, res) => {
      const { cidr, label } = (req.body ?? {}) as { cidr?: unknown; label?: unknown }
      if (typeof cidr !== 'string' || !parseCidr(cidr)) {
        res.status(400).json({ success: false, error: 'A valid IPv4/IPv6 CIDR is required' })
        return
      }
      const entry = await store.addSubnet(cidr, typeof label === 'string' ? label : '')
      onChange?.()
      res.status(201).json({ success: true, subnet: entry })
    })
  )

  router.delete(
    '/subnets',
    handle(async (req, res) => {
      const { cidr } = (req.body ?? {}) as { cidr?: unknown }
      if (typeof cidr !== 'string' || !parseCidr(cidr)) {
        res.status(400).json({ success: false, error: 'A valid IPv4/IPv6 CIDR is required' })
        return
      }
      const removed = await store.removeSubnet(cidr)
      if (removed) onChange?.()
      res.status(removed ? 200 : 404).json({ success: removed, ...(removed ? {} : { error: 'Subnet not found' }) })
    })
  )

  router.post(
    '/api-keys',
    handle(async (req, res) => {
      const { label } = (req.body ?? {}) as { label?: unknown }
      const apiKey = `hp_${randomBytes(24).toString('hex')}`
      const entry = await store.addApiKey(apiKey, typeof label === 'string' ? label : '')
      res.status(201).json({ success: true, apiKey, entry }) // plaintext shown once
    })
  )

  router.delete(
    '/api-keys/:id',
    handle(async (req, res) => {
      const removed = await store.removeApiKey(String(req.params.id))
      res.status(removed ? 200 : 404).json({ success: removed, ...(removed ? {} : { error: 'API key not found' }) })
    })
  )

  return router
}
