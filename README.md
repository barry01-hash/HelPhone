# HelPhone

HelPhone is a React + Vite community emergency response application built on Stellar. It combines wallet-gated help requests, Soroban smart contracts, local ZK privacy proofs, WebAuthn Passkeys, and automated contract storage state backups.

---

## Technical Subsystems & Architecture

### 1. Soroban Storage Inspection & State Snapshot Dumps
- **CLI Exporter**: `scripts/export-contract-state.sh` extracts complete contract storage dumps using `stellar contract inspect` or JSON-RPC queries.
- **Node.js/TypeScript Exporter**: `server/indexer/exporter.ts` indexes storage entries into versioned JSON snapshots (`./snapshots/snapshot-<ledgerSeq>.json`).
- **Automated Backup Cron**: `server/index.ts` automatically runs daily state export tasks to back up contract storage.
- **Disaster Recovery Runbook**: See [`docs/disaster-recovery.md`](docs/disaster-recovery.md) for state restoration procedures.

### 2. Automated Pre-Commit Code Quality Pipeline
- **Husky & lint-staged**: Intercepts `git commit` via `.husky/pre-commit` to automatically run linters and type-checkers on staged files.
- **Quality Verification**:
  - `npm run lint` (`eslint .`) - Code style & quality checks.
  - `npm run typecheck` (`tsc --noEmit`) - Strict TypeScript validation without building output.
  - `npm test` - Vitest test suite execution.
- **GitHub Actions CI**: `.github/workflows/ci.yml` enforces quality, linting, type-checking, state export verification, and crypto matrix tests on all pull requests and pushes.

### 3. Dynamic Feature Canary Rollouts & State Evaluation
- **Feature Flag Engine**: `src/lib/featureFlags.ts` evaluates feature flag toggles dynamically.
- **Remote Config**: Fetches rulesets from `/config.json` without requiring application rebuilds.
- **Percentage Hashing**: Deterministically hashes user IDs / device IDs for 0-100% canary rollouts.
- **React Hook Integration**: Components use `useFeatureFlag('flag_name')` for conditional rendering.

### 4. Cross-Layer Signature Verification Testing Suite
- **Cryptographic Suite**: `src/lib/crypto.ts` provides Ed25519 signature verification, WebAuthn P-256 (ECDSA SHA-256) parsing, and AES-256-GCM encryption/decryption.
- **Passkey Manager**: `src/lib/passkey.ts` handles browser WebAuthn credential registration and authentication.
- **Auth Middleware**: `server/middleware/auth.ts` enforces anti-replay timestamp freshness and cryptographic header verification.
- **Test Matrix**: `test/crypto-verification.test.js` covers positive & negative boundary tests (tampered payload, invalid key, expired signature).

### 5. Performance, Storage Security & Network Resilience
- **HTTP Keep-Alive**: `server/middleware/keepAlive.ts` holds sockets open for 65 s (above the balancer's 60 s idle timeout) so sequential API and WebSocket traffic reuses one TCP connection. See [`docs/performance-optimization.md`](docs/performance-optimization.md).
- **Map Overlay Rendering**: `src/lib/offscreenCanvas.ts` + `src/workers/canvas-worker.js` animate map markers in a Web Worker via OffscreenCanvas, with a main-thread fallback and measured FPS. See [`docs/performance-optimization.md`](docs/performance-optimization.md).
- **Client Storage Encryption**: `src/lib/pbkdf2Key.ts` + `src/lib/secureStorage.ts` derive an AES-256-GCM key via PBKDF2 (100k iterations, per-device salt in IndexedDB) to encrypt local data. See [`docs/security-architecture.md`](docs/security-architecture.md).
- **Network Resilience Testing**: `tests/e2e/throttling.spec.ts` emulates 2G, 3G, a 500 kbps cap, and offline via CDP, with a CI matrix leg per profile. See [`docs/network-resilience.md`](docs/network-resilience.md).

---

## Quick Start

```bash
# Install dependencies
npm install

# Run local development server & indexer
npm run dev

# Run code quality & type checking
npm run lint
npm run typecheck

# Run complete Vitest test suite
npm test

# Export Soroban contract storage state manually
npm run export:state
```

---

## Environment Variables

Configure `.env`:

```bash
VITE_MAPBOX_TOKEN=...
VITE_AEGIS_VAULT_ID=...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
CONTRACT_ID=CC325F37QW7N2F5M3QGHL4A4O7J2K9L0M1N2O3P4Q5R6S7T8U9V0
```

---

## Deployment & Infrastructure

- **Server Blueprint**: Managed via `render.yaml` with web service and daily snapshot cron jobs.
- **CI/CD Pipeline**: GitHub Actions workflow at `.github/workflows/ci.yml`.
