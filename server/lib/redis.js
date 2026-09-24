/**
 * server/lib/redis.ts — Lazy, optional Redis client for shared server state.
 *
 * Redis is only required when REDIS_URL is set. Without it callers fall back
 * to in-process stores, so local dev and tests need no Redis instance.
 */
let client;
export function isRedisConfigured(env = process.env) {
  return Boolean(env.REDIS_URL && env.REDIS_URL.trim());
}
/**
 * Returns the shared client, or null when REDIS_URL is unset. ioredis is
 * imported lazily so it is never loaded on deployments that don't use Redis.
 */
export async function getRedis(env = process.env) {
  if (client !== undefined) return client;
  if (!isRedisConfigured(env)) {
    client = null;
    return client;
  }
  const { Redis } = await import("ioredis");
  const instance = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  instance.on("error", (err) => console.error("[redis] error:", err.message));
  client = instance;
  return client;
}
/** Test hook: inject a client (or reset with undefined). */
export function __setRedisForTests(next) {
  client = next;
}
