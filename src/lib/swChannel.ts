/**
 * Multi-tab / worker broadcast channel (#516)
 *
 * Single BroadcastChannel wiring shared by every browser tab and the service
 * worker so contract lifecycle events, CRDT state and cache invalidation can
 * flow tab→tab and worker→tab without N direct postMessage handlers cluttering
 * the app. Includes a Web Locks based leader election so only one active tab
 * runs the polling / SSE listeners; everyone else just listens.
 *
 * Message envelope:
 *   { type, source, payload, timestamp }
 */

export type ChannelMessageType =
  | 'CONTRACT_EVENT'
  | 'CRDT_SYNC'
  | 'STATE_SYNC'
  | 'SYNC_REQUEST'
  | 'LEADERSHIP_HEARTBEAT'

export interface ChannelMessage<T = unknown> {
  type: ChannelMessageType
  source: string
  payload?: T
  timestamp: number
}

export const SW_CHANNEL_NAME = 'helphone-multitab-v1'
export const LEADER_LOCK_NAME = 'helphone:sync-leader'

const INSTANCE_ID_KEY = 'helphone:instance-id'

/** Stable, process-unique instance id (tab or worker). */
export function getInstanceId(): string {
  if (typeof globalThis !== 'undefined' && (globalThis as any).__helphoneInstanceId) {
    return (globalThis as any).__helphoneInstanceId
  }
  let id: string
  try {
    id = getTabId()
  } catch {
    id = `ctx-${Math.random().toString(36).slice(2, 10)}`
  }
  if (typeof globalThis !== 'undefined') (globalThis as any).__helphoneInstanceId = id
  return id
}

/** Tab scoped id persisted in sessionStorage so reloads keep a stable identity. */
export function getTabId(): string {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(INSTANCE_ID_KEY)
      if (stored) return stored
      const fresh = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(INSTANCE_ID_KEY, fresh)
      return fresh
    } catch {
      // sessionStorage unavailable (private mode etc.) — fall through
    }
  }
  return `tab-${Math.random().toString(36).slice(2, 10)}`
}

function broadcastChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined'
}



export class SwChannel {
  readonly name: string
  readonly instanceId: string
  private readonly handlers = new Set<(message: ChannelMessage) => void>()
  private channel: BroadcastChannel | null = null

  constructor(name: string = SW_CHANNEL_NAME, instanceId: string = getInstanceId()) {
    this.name = name
    this.instanceId = instanceId
    if (broadcastChannelSupported()) {
      try {
        this.channel = new BroadcastChannel(name)
        this.channel.onmessage = (event: MessageEvent) => {
          const data = event.data as ChannelMessage | undefined
          if (!data || !data.source || !data.type) return
          if (data.source === this.instanceId) return // ignore our own echoes
          this.dispatch(data)
        }
      } catch {
        this.channel = null // channels can throw in some sandboxed iframes
      }
    }
  }

  get available(): boolean {
    return this.channel !== null
  }

  /** Post a message to every other tab/worker on the channel. */
  post(type: ChannelMessageType, payload?: unknown): boolean {
    if (!this.channel) return false
    const message: ChannelMessage = {
      type,
      source: this.instanceId,
      payload,
      timestamp: Date.now(),
    }
    try {
      this.channel.postMessage(message)
      return true
    } catch {
      return false
    }
  }

  /** Post a raw message (used by service-worker relay glue). */
  postRaw(message: ChannelMessage): boolean {
    if (!this.channel || !message) return false
    try {
      this.channel.postMessage(message)
      return true
    } catch {
      return false
    }
  }

  /** Subscribe to decoded channel messages. Returns an unsubscribe fn. */
  subscribe(handler: (message: ChannelMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  private dispatch(message: ChannelMessage): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(message)
      } catch (err) {
        // A single broken subscriber must not break the channel.
        console.warn('[swChannel] handler error:', err)
      }
    }
  }

  close(): void {
    this.handlers.clear()
    if (this.channel) {
      try {
        this.channel.close()
      } catch {
        // already closed
      }
      this.channel = null
    }
  }
}

/** App-wide singleton channel. */
export const swChannel = new SwChannel()

/** Convenience: post a CONTRACT_EVENT envelope. */
export function broadcastContractEvent(event: unknown): boolean {
  return swChannel.post('CONTRACT_EVENT', event)
}

// ── Service worker client glue ──────────────────────────────────────
// Tabs hand events to the SW with controller.postMessage; the SW reflects
// them to every other window client (see relayToWindowClients). This covers
// tabs that joined before the channel existed + gives the SW a system-wide
// fan‑out primitive for events observed while it is itself the subscriber.

/** Which client messages should the SW re-broadcast to other tabs? */
export function shouldRelayClientMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const type = (data as any).type
  return type === 'CONTRACT_EVENT' || type === 'CRDT_SYNC' || type === 'STATE_SYNC'
}

/**
 * Send a message to the controlling service worker, if any.
 * Never throws — paves over "ServiceWorker not registered / no controller".
 */
export function postToServiceWorker(data: unknown): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage(data)
      return true
    }
  } catch {
    // controller may have been destroyed mid-post
  }
  return false
}

/** Subscribe to messages relayed back from the service worker. */
export function subscribeToServiceWorkerMessages(
  handler: (message: ChannelMessage) => void,
): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return () => {}
  const listener = (event: MessageEvent) => {
    const data = event.data as ChannelMessage | undefined
    if (!data || !data.type) return
    handler({ ...data, source: data.source || 'service-worker' })
  }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}

/**
 * Reflect an incoming client/broadcast message to every other window client.
 * Testable pure-style helper used by src/service-worker.js.
 */
export async function relayToWindowClients(
  clients: {
    matchAll?: (options?: { type?: string; includeUncontrolled?: boolean }) => Promise<unknown[]>
  },
  sourceClientId: unknown,
  data: unknown,
): Promise<number> {
  if (!clients || typeof clients.matchAll !== 'function') return 0
  const windows = (await clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })) as Array<{ id: unknown; postMessage: (message: unknown) => void }>
  let relayed = 0
  for (const client of windows) {
    if (client.id === sourceClientId) continue
    client.postMessage(data)
    relayed += 1
  }
  return relayed
}

// ── Leader election (Web Locks) ─────────────────────────────────────

export interface LeadershipHandle {
  readonly isLeader: boolean
  /** Stop leading and release the lock (if held). */
  release: () => Promise<void>
}

export function isWebLocksAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.locks !== 'undefined' &&
    typeof navigator.locks.request === 'function'
  )
}

/**
 * Elect a single leader using the Web Locks API. When web locks are missing
 * the promise resolves to null and callers can fall back to a heartbeat
 * election or simply run in every tab.
 */
export async function acquireLeadership(
  lockName: string = LEADER_LOCK_NAME,
  handlers: { onBecomeLeader?: () => void; onLostLeadership?: () => void } = {},
): Promise<LeadershipHandle | null> {
  if (!isWebLocksAvailable()) return null

  let leader = false
  let releaseHold: (() => void) | null = null
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  const abortController = new AbortController()

  const lockPromise = navigator.locks.request(
    lockName,
    { signal: abortController.signal },
    async () => {
      leader = true
      try {
        handlers.onBecomeLeader?.()
      } catch (err) {
        console.warn('[leader] onBecomeLeader failed:', err)
      }
      try {
        await held
      } finally {
        leader = false
        handlers.onLostLeadership?.()
      }
    },
  )
  lockPromise.catch(() => {
    leader = false
  })

  return {
    get isLeader() {
      return leader
    },
    async release() {
      releaseHold?.()
      if (!abortController.signal.aborted) abortController.abort()
      try {
        await lockPromise
      } catch {
        // abort() rejects the lock request — expected on release
      }
    },
  }
}

// ── High level bootstrap (used from src/main.tsx) ───────────────────
// Exactly one active tab runs the Soroban SSE poller and fans events out to
// the rest of the fleet via the channel + the service worker.

export interface MultiTabSyncOptions {
  lockName?: string
  onBecomeLeader?: () => void
  onLostLeadership?: () => void
}

export async function bootstrapMultiTabSync(
  options: MultiTabSyncOptions = {},
): Promise<LeadershipHandle | null> {
  let stopLeaderWork: (() => void) | null = null

  const handle = await acquireLeadership(options.lockName ?? LEADER_LOCK_NAME, {
    onBecomeLeader: async () => {
      stopLeaderWork?.()
      const result = options.onBecomeLeader
        ? options.onBecomeLeader()
        : startDefaultLeaderWork()
      stopLeaderWork = typeof result === 'function' ? result : null
    },
    onLostLeadership: () => {
      stopLeaderWork?.()
      stopLeaderWork = null
      options.onLostLeadership?.()
    },
  })

  return handle
}

/** Default leader work: subscribe to contract SSE events and broadcast them. */
function startDefaultLeaderWork(): (() => void) | null {
  let unsubscribe: (() => void) | null = null
  // Dynamic import keeps the heavy Stellar SDK out of the initial chunk — only
  // the elected leader pays for it.
  import('./contract')
    .then(({ subscribeToContractEvents }) => {
      unsubscribe = () => {}
      unsubscribe = subscribeToContractEvents((event) => {
        broadcastContractEvent(event)
        postToServiceWorker({
          type: 'CONTRACT_EVENT',
          source: getInstanceId(),
          payload: event,
          timestamp: Date.now(),
        })
      })
    })
    .catch((err) => {
      console.warn('[leader] contract event subscription unavailable:', err)
    })
  return () => {
    try {
      unsubscribe?.()
    } catch {
      // already torn down
    }
  }
}

/** Best-effort alias for code that wants a single entry point. */
export async function initMultiTabSync(): Promise<void> {
  await bootstrapMultiTabSync()
}