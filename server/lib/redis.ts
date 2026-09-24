/**
 * server/lib/redis.ts — Lazy, optional Redis client for shared server state.
 *
 * Redis is only required when REDIS_URL is set. Without it callers fall back
 * to in-process stores, so local dev and tests need no Redis instance.
 */

/** The subset of the ioredis hash API the whitelist store depends on. */
export interface RedisHashClient {
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, ...fields: string[]): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
}

let client: RedisHashClient | null | undefined

export function isRedisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim())
}

/**
 * Returns the shared client, or null when REDIS_URL is unset. ioredis is
 * imported lazily so it is never loaded on deployments that don't use Redis.
 */
export async function getRedis(env: NodeJS.ProcessEnv = process.env): Promise<RedisHashClient | null> {
  if (client !== undefined) return client
  if (!isRedisConfigured(env)) {
    client = null
    return client
  }
  const { Redis } = await import('ioredis')
  const instance = new Redis(env.REDIS_URL as string, { maxRetriesPerRequest: 2, lazyConnect: false })
  instance.on('error', (err: Error) => console.error('[redis] error:', err.message))
  client = instance as unknown as RedisHashClient
  return client
}

/** Test hook: inject a client (or reset with undefined). */
export function __setRedisForTests(next: RedisHashClient | null | undefined): void {
  client = next
}
