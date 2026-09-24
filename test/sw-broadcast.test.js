import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { contractCapture } = vi.hoisted(() => ({
  contractCapture: { subscribe: null },
}))

vi.mock('../src/lib/contract', () => ({
  subscribeToContractEvents: vi.fn((cb) => {
    contractCapture.subscribe = cb
    return () => {}
  }),
}))

// Guard against jsdom lacking a BroadcastChannel implementation by injecting a
// faithful in-memory shim before the module under test is imported.
const channelsByTopic = new Map()

class FakeBroadcastChannel {
  constructor(name) {
    this.name = name
    this.onmessage = null
    this.onmessageerror = null
    if (!channelsByTopic.has(name)) channelsByTopic.set(name, new Set())
    channelsByTopic.get(name).add(this)
  }
  postMessage(data) {
    const listeners = channelsByTopic.get(this.name)
    if (!listeners) return
    for (const other of listeners) {
      if (other !== this && typeof other.onmessage === 'function') {
        other.onmessage({ data })
      }
    }
  }
  close() {
    channelsByTopic.get(this.name)?.delete(this)
  }
  addEventListener(type, cb) {
    if (type === 'message') this.onmessage = cb
  }
  removeEventListener() {}
}

const fakeLocks = (() => {
  const queues = new Map()
  const pump = (name) => {
    const queue = queues.get(name) || []
    if (!queue.length) return
    const job = queue[0]
    if (job.running) return
    if (job.signal && job.signal.aborted) {
      queue.shift()
      job.reject(job.signal.reason || new Error('aborted'))
      pump(name)
      return
    }
    job.running = true
    Promise.resolve()
      .then(() => job.cb())
      .then(() => {
        queue.shift()
        job.resolve()
        pump(name)
      })
      .catch(() => {
        queue.shift()
        job.reject(new Error('lock callback failed'))
        pump(name)
      })
  }
  const clear = () => {
    queues.clear()
  }
  return {
    request(name, options, cb) {
      if (typeof options === 'function') {
        cb = options
        options = undefined
      }
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) || []
        queue.push({ cb, resolve, reject, signal: options?.signal })
        queues.set(name, queue)
        pump(name)
      })
    },
    clear,
  }
})()

let swChannelModule

beforeEach(async () => {
  vi.resetModules()
  channelsByTopic.clear()
  globalThis.BroadcastChannel = FakeBroadcastChannel
  Object.defineProperty(navigator, 'locks', {
    value: fakeLocks,
    configurable: true,
  })
  swChannelModule = await import('../src/lib/swChannel')
  fakeLocks.clear()
})

afterEach(() => {
  channelsByTopic.clear()
})

describe('SwChannel (BroadcastChannel tab<->tab messaging)', () => {
  it('delivers messages between instances on the same channel', () => {
    const { SwChannel } = swChannelModule
    const a = new SwChannel('test', 'a')
    const b = new SwChannel('test', 'b')
    const received = []
    b.subscribe((message) => received.push(message))
    expect(a.post('CONTRACT_EVENT', { topic: 'request_created' })).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'CONTRACT_EVENT',
      source: 'a',
      payload: { topic: 'request_created' },
    })
    a.close()
    b.close()
  })

  it('ignores its own echoes (loop protection)', () => {
    const { SwChannel } = swChannelModule
    const a = new SwChannel('echo-test', 'a')
    const received = []
    a.subscribe((message) => received.push(message))
    a.post('STATE_SYNC', { ping: true })
    expect(received).toHaveLength(0)
    a.close()
  })

  it('does not deliver across different channel names', () => {
    const { SwChannel } = swChannelModule
    const a = new SwChannel('chan-one', 'a')
    const b = new SwChannel('chan-two', 'b')
    const received = []
    b.subscribe((message) => received.push(message))
    a.post('SYNC_REQUEST', {})
    expect(received).toHaveLength(0)
    a.close()
    b.close()
  })

  it('post returns false when BroadcastChannel is unavailable', async () => {
    const original = globalThis.BroadcastChannel
    globalThis.BroadcastChannel = undefined
    vi.resetModules()
    const fresh = await import('../src/lib/swChannel')
    const { SwChannel } = fresh
    const a = new SwChannel('no-channel', 'a')
    expect(a.available).toBe(false)
    expect(a.post('CONTRACT_EVENT', {})).toBe(false)
    globalThis.BroadcastChannel = original
  })

  it('exposes a stable per-tab instance id', () => {
    const { SwChannel } = swChannelModule
    const a = new SwChannel('ids', 'one')
    const b = new SwChannel('ids', 'two')
    expect(a.instanceId).toBe('one')
    expect(b.instanceId).toBe('two')
    a.close()
    b.close()
  })
})

describe('Service worker relay helpers', () => {
  it('shouldRelayClientMessage only accepts sync/contract message types', () => {
    const { shouldRelayClientMessage } = swChannelModule
    expect(shouldRelayClientMessage({ type: 'CONTRACT_EVENT' })).toBe(true)
    expect(shouldRelayClientMessage({ type: 'CRDT_SYNC' })).toBe(true)
    expect(shouldRelayClientMessage({ type: 'STATE_SYNC' })).toBe(true)
    expect(shouldRelayClientMessage({ type: 'SKIP_WAITING' })).toBe(false)
    expect(shouldRelayClientMessage(null)).toBe(false)
    expect(shouldRelayClientMessage(42)).toBe(false)
  })

  it('relayToWindowClients fans a message out to every client but the source', async () => {
    const { relayToWindowClients } = swChannelModule
    const other = { id: 'tab-2', postMessage: vi.fn() }
    const source = { id: 'tab-1', postMessage: vi.fn() }
    const clients = {
      matchAll: async () => [other, source, { id: 'tab-3', postMessage: vi.fn() }],
    }
    const relayed = await relayToWindowClients(clients, source.id, { type: 'CONTRACT_EVENT' })
    expect(relayed).toBe(2)
    expect(other.postMessage).toHaveBeenCalledWith({ type: 'CONTRACT_EVENT' })
    expect(source.postMessage).not.toHaveBeenCalled()
  })

  it('relayToWindowClients degrades gracefully without matchAll', async () => {
    const { relayToWindowClients } = swChannelModule
    expect(await relayToWindowClients({}, 'source', { type: 'CONTRACT_EVENT' })).toBe(0)
  })
})

describe('Leader election (Web Locks)', () => {
  it('elects exactly one leader and clears it on release', async () => {
    const { acquireLeadership, LEADER_LOCK_NAME } = swChannelModule
    const became = vi.fn()
    const lost = vi.fn()
    const first = await acquireLeadership(LEADER_LOCK_NAME, {
      onBecomeLeader: became,
      onLostLeadership: lost,
    })
    const second = await acquireLeadership(LEADER_LOCK_NAME, {})

    // Let async lock callbacks settle.
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(first.isLeader).toBe(true)
    expect(second.isLeader).toBe(false)
    expect(became).toHaveBeenCalledTimes(1)

    await first.release()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(first.isLeader).toBe(false)
    expect(lost).toHaveBeenCalledTimes(1)
    // The waiter is handed the lock once released.
    expect(second.isLeader).toBe(true)
  })

  it('returns null when Web Locks is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
    })
    vi.resetModules()
    const fresh = await import('../src/lib/swChannel')
    const handle = await fresh.acquireLeadership('some:lock', {})
    expect(handle).toBe(null)
  })
})

describe('bootstrapMultiTabSync (leader broadcasts contract events)', () => {
  it('leader subscribes to contract events and broadcasts them fleet-wide', async () => {
    contractCapture.subscribe = null

    vi.resetModules()
    const fresh = await import('../src/lib/swChannel')
    // Observe from a *second* tab channel — the leader suppresses its own
    // echoes, exactly like the real BroadcastChannel rules.
    const observer = new fresh.SwChannel(fresh.SW_CHANNEL_NAME, 'observer-tab')
    const received = []
    observer.subscribe((message) => received.push(message))

    const handle = await fresh.bootstrapMultiTabSync()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The dynamic contract import resolves async — wait for the leader work to attach.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(handle.isLeader).toBe(true)
    expect(typeof contractCapture.subscribe).toBe('function')

    contractCapture.subscribe({ topic: 'responder_accepted', id: 7 })
    expect(received.some((m) => m.type === 'CONTRACT_EVENT')).toBe(true)
    const event = received.find((m) => m.type === 'CONTRACT_EVENT')
    expect(event.payload).toEqual({ topic: 'responder_accepted', id: 7 })

    await handle.release()
  })
})