/**
 * server/middleware/keepAlive.js — JS version for Node runtime (mirrors keepAlive.ts)
 *
 * HTTP Keep-Alive Socket Pool Tuning
 *
 * Node's defaults (keepAliveTimeout 5s) are shorter than the idle timeout of
 * the load balancers we sit behind (Render/Cloudflare ~60s), so the balancer
 * regularly reuses a socket the origin has just closed and the client sees a
 * spurious 502. Holding sockets open longer than the balancer does removes
 * that race and lets sequential REST calls and WebSocket upgrades reuse one
 * TCP connection instead of paying a handshake each time.
 *
 * - keepAliveTimeout 65s: must exceed the upstream balancer's 60s idle timeout
 * - headersTimeout 66s:   must exceed keepAliveTimeout or Node can reset a
 *                         reused socket while waiting for the next request line
 * - HTTP/2 is negotiated at the TLS edge; this tunes the HTTP/1.1 origin, and
 *   connection-specific headers are never emitted on an HTTP/2 request.
 */

export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Resolve tuning values from options, then env, then the defaults above. */
export function resolveKeepAliveOptions(
  options = {},
  env = process.env,
) {
  const keepAliveTimeout =
    options.keepAliveTimeout ?? positiveInt(env.KEEP_ALIVE_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS);
  let headersTimeout =
    options.headersTimeout ?? positiveInt(env.HEADERS_TIMEOUT_MS, HEADERS_TIMEOUT_MS);
  // headersTimeout <= keepAliveTimeout reintroduces the reset race; keep it above.
  if (headersTimeout <= keepAliveTimeout) headersTimeout = keepAliveTimeout + 1_000;
  const maxRequestsPerSocket =
    options.maxRequestsPerSocket ?? nonNegativeInt(env.MAX_REQUESTS_PER_SOCKET, 0);
  return { keepAliveTimeout, headersTimeout, maxRequestsPerSocket };
}

/** Apply the tuning to a listening or not-yet-listening http.Server. */
export function applyKeepAliveTuning(
  server, options = {}) {
  const resolved = resolveKeepAliveOptions(options);
  server.keepAliveTimeout = resolved.keepAliveTimeout;
  server.headersTimeout = resolved.headersTimeout;
  server.maxRequestsPerSocket = resolved.maxRequestsPerSocket;
  return resolved;
}

/**
 * Advertise the keep-alive window to clients on HTTP/1.x responses. Skipped for
 * HTTP/2, where Connection/Keep-Alive headers are forbidden.
 */
export function keepAliveMiddleware(options = {}) {
  const { keepAliveTimeout } = resolveKeepAliveOptions(options);
  const seconds = Math.floor(keepAliveTimeout / 1000);
  return (req, res, next) => {
    if (req.httpVersionMajor < 2) {
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', `timeout=${seconds}`);
    }
    next();
  };
}
