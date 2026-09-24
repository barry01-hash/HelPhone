# Soroban Footprint Inspection & Storage Simulation (#517)

## Problem

A Soroban invocation must declare the **exact storage footprint** it touches —
the read-only and read-write ledger keys — or the RPC server's
`simulateTransaction` rejects the envelope before it ever reaches a wallet.
Hand-maintaining that key list in the client is brittle: every new request to a
contract function that reads or writes another key silently breaks transaction
construction, and nobody finds out until the network errors.

## Design

We stop maintaining footprints by hand and instead **derive them from the
network**, cache them, and bake them into envelopes automatically.

```
invoke fn(args)
        │
        ▼
┌──────────────────────────────────────────────┐    cache hit
│ getOrInspectFootprint(contractId, fn, args)  │──────────┐
└──────────────────────────────────────────────┘          │
        │ miss                                            │
        ▼                                                 │
  probe build + simulateTransaction (RPC)                 │
  → readOnly / readWrite ledger keys                      │
  → minResourceFee, footprintXdr                          │
        │                                                 │
  footprintCache.set(key)                                 │
        │                                                 │
        ▼                                                 ▼
  buildSorobanTransaction(…, template)   ── setSorobanData(template.footprintXdr)
        │
        ▼
  wallet signs → submit
```

### Components

| Piece | Where | Role |
| ----- | ----- | ---- |
| `src/lib/footprint.ts` | client library | `inspectFootprint`, `buildSorobanTransaction`, `applyFootprintToTransaction`, in-memory `footprintCache` |
| `src/lib/contract.ts` | client | `buildInvocation()` inspects before signing for argument-determined functions and reuses cached templates for repeated status updates |
| `POST /api/soroban/footprint/inspect` | server | server-side inspection mirror so thin clients / warm-up scripts can query footprints without owning the SDK |
| `src/services/api.ts` | client | `api.fetchFootprint(contractId, functionName, args)` |

### Safety model

- Templates are keyed by `contractId:functionName:stableArgsHash`, so a cache
  hit only ever reuses a template for a byte-identical invocation.
- Only functions whose storage-access pattern is **fully determined by their
  arguments** are eligible for pre-baking into the signing envelope
  (`mark_arrived`, `resolve_request`, `cancel_request`, ownership transfer and
  M-of-N governance calls). Functions whose footprint depends on on-chain state
  (e.g. `create_request`, `accept_request`, `record_expert_verification`) go
  through the normal path: the RPC derives the authoritative keys during the
  pre-sign simulation and `rpc.assembleTransaction` appends them.
- Inspection is a latency optimization, never a correctness dependency: if the
  inspector throws (offline RPC, unknown function), the caller falls back to the
  footprint-free envelope that the SDK always used.
- Cache entries expire after 15 minutes (TTL) and the cache is LRU-capped at 64
  templates, so a stale template can never shadow a fresh one for long.

### Why this helps "repetitive status updates"

`mark_arrived`, `resolve_request` and `cancel_request` are called many times per
session with the same argument shape. After the first invocation, the inspected
footprint template is already resident in memory, so `buildInvocation` assembles
an envelope with the storage keys baked in — no extra inspection round-trip, no
missing-key rejection.

## API

### `POST /api/soroban/footprint/inspect`

```jsonc
{
  "contractId": "CDP5…LSHY",
  "functionName": "mark_arrived",
  "args": [
    { "type": "address", "value": "GDLO…" },
    { "type": "u64", "value": "42" }
  ]
}
```

Response:

```jsonc
{
  "success": true,
  "template": {
    "contractId": "CDP5…LSHY",
    "functionName": "mark_arrived",
    "readOnlyCount": 2,
    "readWriteCount": 1,
    "resourceFee": "12800",
    "footprintXdr": "AAAAAgAAAAA…"
  }
}
```

## Client helpers

```ts
import {
  inspectFootprint,
  buildSorobanTransaction,
  footprintCacheStats,
  clearFootprintCache,
  summarizeFootprint,
} from '../src/lib/footprint'

const template = await inspectFootprint({
  contractId,
  functionName: 'mark_arrived',
  args: [scv(responder, { type: 'address' }), scv(Number(requestId), { type: 'u64' })],
})

console.log(summarizeFootprint(template)) // { readOnlyCount, readWriteCount, totalKeys, resourceFee }
console.log(footprintCacheStats())        // cache telemetry
clearFootprintCache()
```