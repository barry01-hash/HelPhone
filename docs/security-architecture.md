# Security Architecture: Supply Chain Monitoring

This document covers the supply chain security index served by the prover (#600). It builds on the build-pipeline gates from #624–#627 (`scripts/security/`).

## Components

```
package-lock.json            ┐
security-audit.json          ├─> computeSupplyChainReport() ─┬─> GET /api/supply-chain            (JSON)
node_modules/*/package.json  ┘   (cached 60s per worker)     ├─> GET /api/supply-chain/dashboard  (HTML)
                                                             └─> GET /metrics/security           (Prometheus)

scripts/security/license_policy.js  is shared with  scripts/security/license_compliance.js (CI gate)
```

| File                                   | Role                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `server/routes/supplyChainSecurity.ts` | Report computation, dashboard rendering, routers                                               |
| `server/middleware/metrics.ts`         | Prometheus text-format renderer, `helphone_http_requests_total` counter                        |
| `scripts/security/license_policy.js`   | Approved/denied license matrix and exceptions (single source of truth)                         |
| `security-audit.json`                  | `npm audit --json --omit=dev` snapshot written at build time (`npm run security:audit-report`) |

## Design decisions

**No shelling out on the request path.** `npm audit` makes network calls and takes seconds. If an endpoint could trigger it, anyone could use that endpoint to exhaust the prover. CVE data is therefore a build-time snapshot, and the report exposes `reportAgeSeconds` so a stale snapshot is visible. Prometheus exports it as `helphone_audit_report_age_seconds`.

**Missing data is never scored as good.** If the audit snapshot is missing or malformed, `vulnerabilities.source` is `unavailable` and `index.partial` is `true`. The composite index is then computed from the other components only. Alert on `helphone_supply_chain_index_partial == 1` in production.

**No new dependencies.** The metrics exporter is about 80 lines of built-in-only code, not `prom-client`. A supply chain endpoint should not widen the supply chain it reports on.

**Low label cardinality.** Request counters use the matched Express route template (`/api/responder-status/:address`), never the raw URL. Unmatched requests are bucketed as `unmatched`. That keeps addresses and nullifiers out of metric labels.

**Dashboard hardening.** The dashboard is static server-rendered HTML with every value HTML-escaped. It is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, so it runs no scripts and makes no outbound fetches.

## Scoring

The composite index is a weighted mean of four 0–100 components. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below that.

| Component          | Weight | Formula                                                                                                   |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| Vulnerabilities    | 0.4    | `100 − (40·critical + 15·high + 4·moderate + 1·low)`, floored at 0                                        |
| Lockfile integrity | 0.3    | `% packages with integrity hash − 5 per non-registry source − 1 per sha1-only hash`; 0 without a lockfile |
| License compliance | 0.2    | `% packages on the approved matrix`; 0 if any non-excepted GPL/AGPL dependency exists                     |
| Sustainability     | 0.1    | `100 − 1000 × (deprecated / total)`                                                                       |

If a component is `null` (currently only vulnerabilities, when no snapshot exists), its weight is redistributed across the remaining components.

Non-registry sources are listed explicitly (e.g. the JSR-hosted `@creit-tech/stellar-wallets-kit`). They are not necessarily bad, but they skip npm's registry signing, so each one should be a deliberate choice.

## Suggested alerts

```yaml
- alert: SupplyChainCriticalCVE
  expr: helphone_dependency_vulnerabilities{severity="critical"} > 0
- alert: SupplyChainIndexPartial
  expr: helphone_supply_chain_index_partial == 1
  for: 1h
- alert: SupplyChainAuditStale
  expr: helphone_audit_report_age_seconds > 7 * 24 * 3600
- alert: DeniedLicenseIntroduced
  expr: helphone_dependency_licenses{status="denied"} > 0
```

---

# Client Storage Encryption: PBKDF2 Key Derivation

Sensitive client-side data (for example offline help-request locations) is encrypted before it touches browser storage. The pipeline is in `src/lib/pbkdf2Key.ts` and `src/lib/secureStorage.ts`.

```
passphrase ─┐
            ├─> PBKDF2-HMAC-SHA-256, 100,000 iterations ─> AES-256-GCM key (non-extractable)
device salt ┘                                                      │
(IndexedDB)                                                        └─> SecureStorage.setItem / getItem
```

| File | Role |
| --- | --- |
| `src/lib/pbkdf2Key.ts` | Salt lifecycle, key derivation, latency benchmark |
| `src/lib/secureStorage.ts` | AES-GCM sealed `localStorage` wrapper (`hp_secure:<name>`) |
| `src/stores/helpStore.ts` | `persistHelpStore` / `hydrateHelpStore` for the offline CRDT store |

**Salt.** 16 random bytes, generated once per device and kept in IndexedDB (`helphone-secure` / `kdf`). It is not secret. Its job is to make the derived key unique per device, which defeats precomputed tables. A stored salt with the wrong length is discarded and regenerated.

**Key.** Derived with `extractable: false`, so page script can use the key but cannot read its bytes.

**Sealed values.** Each write uses a fresh 12-byte IV. Format: `{ v: 1, iv, ct }`, base64. AES-GCM authenticates the ciphertext, so a wrong passphrase or tampered data is rejected with an error, never decoded to garbage.

**Iteration count.** 100,000 meets the issue's requirement. OWASP's current guidance for PBKDF2-HMAC-SHA-256 is far higher (600,000), and `src/lib/keyBackup.ts` already uses 210,000 for key backups. Raising `PBKDF2_ITERATIONS` is a one-line change. Existing entries would need re-encrypting because the key changes, so bump `v` in `secureStorage.ts` when doing so.

**Latency budget.** `benchmarkKeyDerivation()` reports the median and worst latency and whether the median is within 50 ms. `scheduleKeyDerivationBenchmark()` runs it when the browser is idle after startup and logs a warning if the device is over budget. It never blocks startup or throws. The 50 ms figure is a target, not a guarantee: derivation time depends on the device, and slow or busy hardware will exceed it. On a loaded development machine the measurement was roughly 100 to 900 ms.

**Limits.** The passphrase itself is never stored. Locking (`SecureStorage.lock()`) only drops the in-memory key. It does not clear data already decrypted into application state.
