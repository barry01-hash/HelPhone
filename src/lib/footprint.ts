/**
 * Soroban footprint inspection & template caching (#517)
 *
 * Soroban transactions must declare the exact storage footprint (the ledger
 * keys a contract invocation reads / writes) or the RPC's simulateTransaction
 * rejects them. Instead of hand-maintaining that key list in the client, we:
 *
 *   1. Inspect a contract function up-front with a probe simulateTransaction
 *      call (before the user signs anything),
 *   2. Automatically append the returned read-only / read-write ledger keys to
 *      later transaction envelopes via applyFootprintToTransaction /
 *      buildSorobanTransaction,
 *   3. Cache the footprint TEMPLATE in memory so repetitive status-update
 *      transactions (mark_arrived, resolve_request, …) reuse the same stored
 *      keys without another inspection round-trip.
 *
 * Templates are keyed by contractId + functionName + a stable hash of the raw
 * args so cache hits are always for byte-identical invocations. Any cache entry
 * is bounded by a TTL and an LRU cap, so a stale hit can never live forever.
 */

import {
  rpc,
  Contract,
  TransactionBuilder,
  Operation,
  Account,
  Keypair,
  BASE_FEE,
  Networks,
  SorobanDataBuilder,
} from '@stellar/stellar-sdk'

/** A cached, server-verified footprint for one invocation shape. */
export interface FootprintTemplate {
  contractId: string
  functionName: string
  argsKey: string
  /** read-only storage keys (xdr.LedgerKey[], serialized for telemetry) */
  readOnly: unknown[]
  /** read-write storage keys (xdr.LedgerKey[], serialized for telemetry) */
  readWrite: unknown[]
  /** minResourceFee reported by the inspector RPC */
  resourceFee: string
  /** base64 xdr.SorobanTransactionData — feed directly to setSorobanData */
  footprintXdr: string
  generatedAt: number
}

export interface FootprintInspectOptions {
  contractId: string
  functionName: string
  /** Already-encoded scVals exactly as the invocation will use them. */
  args?: unknown[]
  /** Optional explicit rpcUrl; falls back to an optional provided server. */
  rpcUrl?: string
  /** Anything with simulateTransaction(tx) — injected for tests. */
  simulate?: (tx: unknown) => Promise<unknown>
  networkPassphrase?: string
}

/** Result of an inspection: either a cached/derived template or a reason why
 *  one could not be produced. Callers treat failures as a soft degradation —
 *  the pre-sign simulation derives the footprint as it always has. */
export interface FootprintInspectResult {
  success: boolean
  template?: FootprintTemplate
  error?: string
  /** true when served from the in-memory cache (no RPC round-trip). */
  fromCache?: boolean
}

const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_ENTRIES = 64

// ── Stable args hashing ────────────────────────────────────────────

/** Collapse raw invocation args into a short, stable cache key. */
export function makeFootprintArgsKey(args: unknown[] | undefined): string {
  if (!args || args.length === 0) return 'noargs'
  let hash = 2166136261
  const encode = (value: unknown): string => {
    if (value == null) return 'null'
    if (typeof value === 'bigint') return `i:${value.toString()}`
    if (typeof value === 'string') return `s:${value}`
    if (Array.isArray(value)) return `a:[${value.map(encode).join('|')}]`
    if (typeof value === 'object') {
      // scVal instances expose toJSON / toXDR; fall back to JSON when unknown.
      try {
        if (typeof (value as { toXDR?: unknown }).toXDR === 'function') {
          return `x:${(value as { toXDR: (format?: string) => string }).toXDR('base64')}`
        }
      } catch {
        // fall through to JSON
      }
      return `o:${JSON.stringify(value)}`
    }
    return `p:${String(value)}`
  }
  const encoded = args.map(encode).join('|')
  for (let i = 0; i < encoded.length; i += 1) {
    hash ^= encoded.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${(hash >>> 0).toString(36)}:${encoded.length}`
}

// ── In-memory template cache ───────────────────────────────────────

export interface FootprintCacheStats {
  size: number
  maxEntries: number
  ttlMs: number
  hits: number
  misses: number
}

class FootprintTemplateCache {
  private entries = new Map<string, { template: FootprintTemplate; insertedAt: number }>()
  private hits = 0
  private misses = 0

  get(key: string): FootprintTemplate | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (Date.now() - entry.insertedAt > CACHE_TTL_MS) {
      this.entries.delete(key)
      this.misses += 1
      return undefined
    }
    // LRU touch
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return entry.template
  }

  set(key: string, template: FootprintTemplate): void {
    if (this.entries.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest) this.entries.delete(oldest)
    }
    this.entries.set(key, { template, insertedAt: Date.now() })
  }

  clear(): void {
    this.entries.clear()
    this.hits = 0
    this.misses = 0
  }

  stats(): FootprintCacheStats {
    return {
      size: this.entries.size,
      maxEntries: CACHE_MAX_ENTRIES,
      ttlMs: CACHE_TTL_MS,
      hits: this.hits,
      misses: this.misses,
    }
  }
}

/** Process-wide footprint template cache. */
export const footprintCache = new FootprintTemplateCache()

export function clearFootprintCache(): void {
  footprintCache.clear()
}

export function footprintCacheStats(): FootprintCacheStats {
  return footprintCache.stats()
}

/**
 * Read a previously inspected template from the in-memory cache — never
 * triggers an RPC call. The write path uses this so repetitive status-update
 * transactions reuse a cached footprint without doubling RPC round-trips.
 */
export function getCachedFootprintTemplate(
  contractId: string,
  functionName: string,
  args: unknown[] | undefined,
): FootprintTemplate | undefined {
  return footprintCache.get(footprintCacheKey(contractId, functionName, makeFootprintArgsKey(args)))
}

/**
 * Best-effort warm-up: inspect a list of invocation shapes so their templates
 * are resident before the first real submission. Safe to call from the leader
 * tab / a warm-up script; failures only log and are skipped.
 */
export async function warmFootprintTemplates(
  entries: Array<Pick<FootprintInspectOptions, 'contractId' | 'functionName' | 'args'>>,
  onResult?: (contractId: string, functionName: string, result: FootprintInspectResult) => void,
): Promise<FootprintTemplate[]> {
  const templates: FootprintTemplate[] = []
  for (const entry of entries) {
    try {
      const result = await inspectFootprint(entry)
      onResult?.(entry.contractId, entry.functionName, result)
      if (result.success && result.template) templates.push(result.template)
    } catch (err) {
      console.warn(
        `[footprint] warm-up failed for ${entry.contractId}:${entry.functionName}`,
        err,
      )
    }
  }
  return templates
}

// ── Inspector ──────────────────────────────────────────────────────

/**
 * Inspect a contract function's storage footprint via a probe
 * simulateTransaction call — the RPC executes in "what would run" mode and
 * returns the exact ledger key set the invocation touches. This happens
 * *before* any user signature is requested.
 */
export async function inspectFootprint(
  options: FootprintInspectOptions,
): Promise<FootprintInspectResult> {
  const { contractId, functionName, args = [], rpcUrl, simulate, networkPassphrase } = options
  const argsKey = makeFootprintArgsKey(args)

  const hit = footprintCache.get(footprintCacheKey(contractId, functionName, argsKey))
  if (hit) return { success: true, template: hit, fromCache: true }

  let sim: any
  try {
    const server =
      typeof simulate === 'function'
        ? { simulateTransaction: simulate as (tx: unknown) => Promise<unknown> }
        : new rpc.Server(rpcUrl || defaultRpcUrl(), { timeout: 30_000 })

    const source = new Account(Keypair.random().publicKey(), '0')
    const passphrase = networkPassphrase || Networks.TESTNET
    const probe = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: functionName,
          args: args as never[],
        }),
      )
      .setTimeout(30)
      .build()

    sim = await server.simulateTransaction(probe)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (sim?.error) {
    return {
      success: false,
      error: `Footprint inspection failed for ${functionName}: ${JSON.stringify(sim.error)}`,
    }
  }

  // The SDK parses rpc responses into a SorobanDataBuilder; raw providers may
  // hand back a base64 payload string — decode that case explicitly.
  let sorobanBuilder: SorobanDataBuilder
  if (typeof sim?.transactionData === 'string') {
    sorobanBuilder = new SorobanDataBuilder(sim.transactionData)
  } else if (sim?.transactionData && typeof (sim.transactionData as SorobanDataBuilder).build === 'function') {
    sorobanBuilder = new SorobanDataBuilder((sim.transactionData as SorobanDataBuilder).build())
  } else {
    sorobanBuilder = new SorobanDataBuilder()
  }

  const readOnly = sorobanBuilder.getReadOnly()
  const readWrite = sorobanBuilder.getReadWrite()
  const footprintXdr = sorobanBuilder.build().toXDR('base64')
  const resourceFee = String(sim?.minResourceFee ?? '0')

  const template: FootprintTemplate = {
    contractId,
    functionName,
    argsKey,
    readOnly: readOnly.map((key) => safeDescribeKey(key)),
    readWrite: readWrite.map((key) => safeDescribeKey(key)),
    resourceFee,
    footprintXdr,
    generatedAt: Date.now(),
  }

  footprintCache.set(footprintCacheKey(contractId, functionName, argsKey), template)
  return { success: true, template, fromCache: false }
}

function footprintCacheKey(contractId: string, functionName: string, argsKey: string) {
  return `${contractId}:${functionName}:${argsKey}`
}

function defaultRpcUrl(): string {
  return (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org'
  )
}

/** Serialize a ledger key for diagnostics without depending on xdr internals. */
function safeDescribeKey(key: unknown): unknown {
  try {
    if (key && typeof (key as { toXDR?: unknown }).toXDR === 'function') {
      return (key as { toXDR: (format: string) => string }).toXDR('base64')
    }
    return String(key)
  } catch {
    return '<ledger-key>'
  }
}

// ── Envelope helpers ───────────────────────────────────────────────

/**
 * Bake a cached/server-derived footprint into a TransactionBuilder so the
 * transaction envelope already declares its read-only and read-write storage
 * keys before it reaches the wallet for signing.
 */
export function applyFootprintToTransaction(
  builder: { setSorobanData: (data: string) => unknown },
  template: FootprintTemplate,
): void {
  builder.setSorobanData(template.footprintXdr)
}

export interface BuildSorobanTransactionOptions {
  account: unknown
  contractId: string
  functionName: string
  args?: unknown[]
  template?: FootprintTemplate
  networkPassphrase?: string
  fee?: string | number
  timeoutSeconds?: number
}

/**
 * Build an invokeContractFunction transaction. When a (cached) footprint
 * template is supplied the envelope is assembled with the storage keys already
 * attached; otherwise it is built footprint-free (the RPC will derive them).
 *
 * Returns an object exposing both the TransactionBuilder (for callers that need
 * to extend the envelope) and the final built transaction.
 */
export function buildSorobanTransaction(
  options: BuildSorobanTransactionOptions,
): {
  builder: TransactionBuilder
  transaction: import('@stellar/stellar-sdk').Transaction
} {
  const {
    account,
    contractId,
    functionName,
    args = [],
    template,
    networkPassphrase = Networks.TESTNET,
    fee = BASE_FEE,
    timeoutSeconds = 30,
  } = options

  const builder = new TransactionBuilder(account as Account, {
    fee: String(fee),
    networkPassphrase,
  }).addOperation(
    Operation.invokeContractFunction({
      contract: contractId,
      function: functionName,
      args: args as never[],
    }),
  )

  if (template) applyFootprintToTransaction(builder, template)

  const transaction = builder.setTimeout(timeoutSeconds).build()
  return { builder, transaction }
}

/** Human/telemetry summary of a footprint template. */
export function summarizeFootprint(template: FootprintTemplate): {
  readOnlyCount: number
  readWriteCount: number
  totalKeys: number
  resourceFee: string
} {
  const readOnlyCount = template.readOnly.length
  const readWriteCount = template.readWrite.length
  return {
    readOnlyCount,
    readWriteCount,
    totalKeys: readOnlyCount + readWriteCount,
    resourceFee: template.resourceFee,
  }
}