/**
 * src/lib/networkEstimator.ts — RPC health inspector & failover selector.
 *
 * Probes a pool of Soroban RPC endpoints with a lightweight `getHealth`
 * JSON-RPC call, keeps a smoothed (EWMA) round-trip time per endpoint, and
 * decides which endpoint the client should use:
 *
 *  - The primary (first) endpoint stays active while it is healthy.
 *  - After `failureThreshold` consecutive failures it is abandoned for the
 *    healthy endpoint with the lowest smoothed latency.
 *  - When the primary recovers it is switched back to.
 *
 * Real-call failures can be fed in with `reportFailure()` so a dying node is
 * dropped without waiting for the next probe.
 *
 * Endpoint URLs may embed provider API keys, so snapshots expose only a
 * `label` (the hostname) and the active URL is handed solely to `onChange`.
 */
import type { EndpointHealth, NetworkQuality, RpcHealthSnapshot } from '../types/index'

export const DEFAULT_PROBE_INTERVAL_MS = 30_000
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000
export const DEFAULT_FAILURE_THRESHOLD = 2
/** Weight of the newest sample in the smoothed latency. */
export const EWMA_ALPHA = 0.3
/** Smoothed latency above this is reported as "degraded". */
export const DEGRADED_LATENCY_MS = 800

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  error?: string
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export interface ProbeOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => number
}

/** Measure one `getHealth` round trip. Never throws. */
export async function probeEndpoint(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const now = opts.now ?? (() => performance.now())
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = now()
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: controller.signal,
    })
    const latencyMs = Math.max(0, now() - start)
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { result?: { status?: string }; error?: unknown }
    if (body?.error || body?.result?.status !== 'healthy') {
      return { ok: false, latencyMs, error: 'node not healthy' }
    }
    return { ok: true, latencyMs }
  } catch (err) {
    const aborted = controller.signal.aborted
    return { ok: false, latencyMs: Math.max(0, now() - start), error: aborted ? 'timeout' : (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

/** Hostname only — never the path/query, which may carry an API key. */
export function endpointLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid-url'
  }
}

/** Split a comma-separated URL list, dropping blanks and duplicates. */
export function parseEndpointList(...raw: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  for (const chunk of raw) {
    for (const part of (chunk ?? '').split(',')) {
      const url = part.trim()
      if (url) seen.add(url)
    }
  }
  return [...seen]
}

interface EndpointState {
  url: string
  ewmaMs: number | null
  lastMs: number | null
  healthy: boolean
  failures: number
  checkedAt: number | null
  error?: string
}

export interface EstimatorOptions {
  /** Primary first, then backups. */
  endpoints: string[]
  probeIntervalMs?: number
  timeoutMs?: number
  failureThreshold?: number
  fetchImpl?: FetchLike
  /** Clock for both latency timing and `lastCheckedAt`; defaults to performance.now / Date.now. */
  now?: () => number
  /** Called with the new active URL whenever failover (or fail-back) happens. */
  onChange?: (url: string, previous: string) => void
}

export interface NetworkEstimator {
  probeAll(): Promise<RpcHealthSnapshot>
  /** Record a failed real request against an endpoint. */
  reportFailure(url: string): void
  getActiveUrl(): string
  getSnapshot(): RpcHealthSnapshot
  subscribe(listener: () => void): () => void
  start(): void
  stop(): void
}

export function createNetworkEstimator(opts: EstimatorOptions): NetworkEstimator {
  const urls = [...new Set(opts.endpoints)]
  if (urls.length === 0) throw new Error('createNetworkEstimator requires at least one endpoint')

  const wallClock = opts.now ?? (() => Date.now())
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const threshold = Math.max(1, opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
  const states: EndpointState[] = urls.map((url) => ({
    url,
    ewmaMs: null,
    lastMs: null,
    healthy: true, // optimistic until probed
    failures: 0,
    checkedAt: null,
  }))
  const listeners = new Set<() => void>()
  let active = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let probing: Promise<RpcHealthSnapshot> | null = null
  let snapshot: RpcHealthSnapshot | null = null

  function quality(): NetworkQuality {
    const activeState = states[active]
    if (!activeState.healthy && !states.some((s) => s.healthy)) return 'offline'
    return activeState.healthy && (activeState.ewmaMs ?? 0) <= DEGRADED_LATENCY_MS ? 'good' : 'degraded'
  }

  function build(): RpcHealthSnapshot {
    const endpoints: EndpointHealth[] = states.map((s, i) => ({
      label: endpointLabel(s.url),
      latencyMs: s.ewmaMs === null ? null : Math.round(s.ewmaMs),
      lastLatencyMs: s.lastMs === null ? null : Math.round(s.lastMs),
      healthy: s.healthy,
      consecutiveFailures: s.failures,
      lastCheckedAt: s.checkedAt,
      active: i === active,
      primary: i === 0,
    }))
    return { activeLabel: endpoints[active].label, activeLatencyMs: endpoints[active].latencyMs, quality: quality(), endpoints }
  }

  function publish(): void {
    snapshot = build()
    for (const l of listeners) l()
  }

  /** Pick the endpoint that should be active; returns true if it changed. */
  function reselect(): boolean {
    const primary = states[0]
    let next = active
    if (primary.healthy) {
      next = 0 // fail back to (or stay on) a healthy primary
    } else if (!states[active].healthy) {
      const healthy = states.filter((s) => s.healthy)
      if (healthy.length > 0) {
        const best = healthy.reduce((a, b) => ((a.ewmaMs ?? Infinity) <= (b.ewmaMs ?? Infinity) ? a : b))
        next = states.indexOf(best)
      }
    }
    if (next === active) return false
    const previous = states[active].url
    active = next
    opts.onChange?.(states[active].url, previous)
    return true
  }

  function record(state: EndpointState, result: ProbeResult): void {
    state.checkedAt = wallClock()
    state.error = result.error
    if (result.ok) {
      state.failures = 0
      state.healthy = true
      state.lastMs = result.latencyMs
      state.ewmaMs = state.ewmaMs === null ? result.latencyMs : EWMA_ALPHA * result.latencyMs + (1 - EWMA_ALPHA) * state.ewmaMs
    } else {
      state.failures += 1
      if (state.failures >= threshold) state.healthy = false
    }
  }

  function probeAll(): Promise<RpcHealthSnapshot> {
    if (probing) return probing // coalesce overlapping probes
    probing = (async () => {
      const results = await Promise.all(
        states.map((s) => probeEndpoint(s.url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, now: opts.now }))
      )
      results.forEach((r, i) => record(states[i], r))
      reselect()
      publish()
      return snapshot as RpcHealthSnapshot
    })().finally(() => {
      probing = null
    })
    return probing
  }

  snapshot = build()

  return {
    probeAll,
    reportFailure(url) {
      const state = states.find((s) => s.url === url)
      if (!state) return
      record(state, { ok: false, latencyMs: 0, error: 'request failed' })
      reselect()
      publish()
    },
    getActiveUrl: () => states[active].url,
    getSnapshot: () => snapshot as RpcHealthSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (timer) return
      void probeAll()
      timer = setInterval(() => void probeAll(), probeIntervalMs)
      ;(timer as { unref?: () => void }).unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
