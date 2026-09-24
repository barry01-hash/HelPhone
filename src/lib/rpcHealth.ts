/**
 * src/lib/rpcHealth.ts — Shared RPC health singleton (#539).
 *
 * `contract.ts` registers its endpoint pool here at load time via
 * `initRpcHealth`; UI code (see `useNetworkQuality`) reads it from here. The
 * indirection keeps the UI decoupled from `contract.ts` and gives a defined
 * "unknown" state until an estimator has been registered.
 */
import { createNetworkEstimator } from './networkEstimator'
import type { EstimatorOptions, NetworkEstimator } from './networkEstimator'
import type { RpcHealthSnapshot } from '../types/index'

const UNKNOWN: RpcHealthSnapshot = { activeLabel: '', activeLatencyMs: null, quality: 'unknown', endpoints: [] }

let estimator: NetworkEstimator | null = null
let unbridge: (() => void) | null = null
let monitoring = false
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((l) => l())

/** Register (or replace) the estimator for the current endpoint pool. */
export function initRpcHealth(opts: EstimatorOptions): NetworkEstimator {
  estimator?.stop()
  unbridge?.()
  estimator = createNetworkEstimator(opts)
  unbridge = estimator.subscribe(notify)
  if (monitoring) estimator.start()
  notify()
  return estimator
}

export function getRpcHealthSnapshot(): RpcHealthSnapshot {
  return estimator ? estimator.getSnapshot() : UNKNOWN
}

/** Subscribe to snapshot changes; returns an unsubscribe function. */
export function subscribeRpcHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Begin periodic probing (idempotent). Skipped under Vite's test mode or when VITE_DISABLE_RPC_MONITOR=true. */
export function startRpcMonitoring(): void {
  if (import.meta.env?.MODE === 'test' || import.meta.env?.VITE_DISABLE_RPC_MONITOR === 'true') return
  monitoring = true
  estimator?.start()
}

export function stopRpcMonitoring(): void {
  monitoring = false
  estimator?.stop()
}

/** Probe every endpoint now and resolve with the fresh snapshot. */
export async function probeRpcNow(): Promise<RpcHealthSnapshot> {
  return estimator ? estimator.probeAll() : UNKNOWN
}

/** Count a failed real request against the currently active endpoint. */
export function reportRpcFailure(): void {
  if (estimator) estimator.reportFailure(estimator.getActiveUrl())
}

/** Test hook: drop the registered estimator and any monitoring state. */
export function __resetRpcHealth(): void {
  estimator?.stop()
  unbridge?.()
  estimator = null
  unbridge = null
  monitoring = false
  listeners.clear()
}
