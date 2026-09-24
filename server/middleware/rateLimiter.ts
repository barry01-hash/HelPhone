import { rateLimit } from 'express-rate-limit'
import { isWhitelisted } from './whitelist.js'

/**
 * General API rate limiter — applied to all routes.
 * Allows 100 requests per minute per IP.
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Verified emergency-service callers (see whitelist.ts) are never throttled.
  skip: isWhitelisted,
  message: {
    success: false,
    error: 'Too many requests — please slow down and try again shortly.',
  },
})

/**
 * Strict rate limiter for ZK proof endpoints.
 *
 * Proof generation is CPU-intensive; restrict to 10 requests per minute
 * per IP to protect the server from abuse while still allowing
 * legitimate use (a single user rarely needs more than a few proofs/min).
 */
export const proverLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Verified emergency-service callers (see whitelist.ts) are never throttled.
  skip: isWhitelisted,
  message: {
    success: false,
    error: 'ZK prover rate limit exceeded — at most 10 proofs per minute per IP.',
  },
})
