# Network Resilience Testing

`tests/e2e/throttling.spec.ts` drives Chromium through the Chrome DevTools Protocol (CDP) to check that HelPhone behaves under the network conditions its users actually have during an emergency: slow mobile data, a capped connection, and no connection at all.

## Profiles

| Profile | Download | Upload | Latency | Source |
| --- | --- | --- | --- | --- |
| `2g` | 50 kbps | 20 kbps | 500 ms | Chrome DevTools "GPRS" preset |
| `3g` | 400 kbps | 400 kbps | 400 ms | Chrome DevTools "Slow 3G" preset |
| `cap-500kbps` | 500 kbps | 500 kbps | 50 ms | The 500 kbps bandwidth cap from the SLA |
| `offline` | none | none | n/a | `Network.emulateNetworkConditions { offline: true }` |

CDP takes throughput in bytes per second, so the spec converts with `kbps * 1024 / 8`.

## What is asserted

- **The throttle is real.** A request cannot complete faster than the emulated latency or the bandwidth cap allows. Without this, a silently ineffective throttle would make every other test pass vacuously.
- **Requests queue, not fail.** Five concurrent requests under each throttled profile all resolve successfully.
- **The app stays usable.** A full navigation under each throttled profile reaches the landing content, and no offline banner appears while the connection is merely slow.
- **Offline indicator.** Going offline shows the alert banner (`OfflineIndicator`, mounted globally in `src/main.tsx`); reconnecting hides it. A page checked with `context.setOffline` reports `navigator.onLine === false`.
- **Fail fast, then recover.** While offline a request rejects with a `TypeError` in under 5 seconds instead of hanging, and succeeds again once the network returns.

The throttling project is separate from the default one (`playwright.config.js`) because slow-network navigations need a 180 s timeout and would otherwise slow the whole e2e suite.

## Running

```bash
npm run test:e2e:throttling                        # all profiles
npm run test:e2e:throttling -- --grep "\[2g\]"     # one profile
```

CDP network emulation is Chromium-only, so the spec skips other browsers.

## CI

The `e2e-throttling` job in `.github/workflows/ci.yml` runs one matrix leg per profile (`2g`, `3g`, `cap-500kbps`, `offline`) with `fail-fast` off, so a regression names the network class it breaks on and one failing leg does not hide the others. Traces are uploaded on failure.

## Known limits

- The suite measures behaviour, not a page-load SLA number. A hard time budget for a full page load under 500 kbps depends on bundle size and CI runner speed. Add one once a baseline has been recorded from real CI runs.
- "Requests queue gracefully" is asserted for same-origin fetches from the page. It does not yet cover the wallet or Stellar RPC calls, which need a test network.

## RPC Health & Failover (runtime)

The client talks to a Soroban RPC node for every read and transaction. A single
slow or dead node used to make the whole app look broken. The network estimator
(`src/lib/networkEstimator.ts`) measures the health of a pool of nodes and
switches to a better one automatically.

### Configuration

| Env (Vite) | Meaning |
|------------|---------|
| `VITE_STELLAR_<NETWORK>_RPC_URL` | Primary RPC node for that network (existing) |
| `VITE_STELLAR_<NETWORK>_RPC_FALLBACK_URLS` | Comma-separated backups for that network, e.g. `VITE_STELLAR_TESTNET_RPC_FALLBACK_URLS` |
| `VITE_STELLAR_RPC_FALLBACK_URLS` | Comma-separated backups used for every network |
| `VITE_DISABLE_RPC_MONITOR` | `true` turns periodic probing off (failover on real errors still works) |

The pool is `primary, ...backups` with duplicates removed. With no backups
configured the estimator still reports health for the single node.

### How it works

1. **Probe.** Every 30 s each node gets a JSON-RPC `getHealth` request with a
   5 s timeout. A node is healthy only if it answers 2xx with
   `result.status === "healthy"`.
2. **Smooth.** Round-trip time is tracked as an EWMA (α = 0.3) so one slow
   sample does not flip the choice.
3. **Fail over.** The primary stays active while healthy — even if a backup is
   faster, to keep behaviour predictable. After **2 consecutive failures** it is
   marked unhealthy and the client switches to the healthy backup with the lowest
   smoothed latency. If that backup later fails too, it moves to the next best.
4. **Fail back.** As soon as the primary probes healthy again it becomes active.
5. **Real errors count too.** `withRetry` in `contract.ts` reports each
   network-shaped failure (timeout, 502/503/504, fetch errors) against the active
   node, so a node that dies mid-session is dropped without waiting for the next
   probe. Contract-logic errors never count.

Switching is done by re-creating the `rpc.Server` in `contract.ts`; in-flight
requests finish on the node they started on.

### Status indicator

`useNetworkQuality()` (`src/hooks/useNetworkQuality.js`) starts probing while any
consumer is mounted and returns:

```js
{ activeLabel, activeLatencyMs, quality, endpoints: [...], refresh }
```

`quality` is `good` (active node healthy, ≤ 800 ms), `degraded` (healthy but
slow, or serving from a stressed node), `offline` (no node healthy) or `unknown`
(no estimator registered). The Help page shows this as a status pill, including
"backup node" when failed over.

### Privacy & safety

- RPC URLs can embed provider API keys, so snapshots and the UI expose only the
  **hostname**; the full URL never leaves the estimator except to build the
  replacement `rpc.Server`.
- Probes are plain `getHealth` calls: no user data, wallet address or request
  content is sent.
- Probing is skipped in Vite test mode so unit tests never hit the network.

### Limits

- Backups must serve the same network; the estimator does not verify the
  network passphrase or ledger height, so a lagging-but-"healthy" node can still
  be chosen. Point backups at reputable providers for the same network.
- Latency is measured from the browser to the node, which is what users
  experience, but it varies by location.
