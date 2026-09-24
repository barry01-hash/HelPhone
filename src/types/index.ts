/**
 * HelPhone System-Wide TypeScript Definitions
 */

// --- Feature Flags Subsystem ---
export interface FeatureFlagRuleset {
  enabled: boolean
  rolloutPercentage?: number
  targets?: {
    roles?: string[]
    environments?: string[]
    userIds?: string[]
  }
  environmentOverrides?: Record<string, boolean>
}

export interface FeatureFlagConfig {
  version: string
  updatedAt?: string
  flags: Record<string, FeatureFlagRuleset>
}

export interface UserContext {
  id?: string
  role?: string
  environment?: string
  deviceId?: string
}

export interface FlagEvaluationResult {
  flagKey: string
  enabled: boolean
  reason: 'default' | 'env_override' | 'target_match' | 'percentage_rollout' | 'disabled'
}

// --- Soroban State & Exporter Subsystem ---
export interface SorobanStorageEntry {
  key: string
  val: any
  durability: 'instance' | 'persistent' | 'temporary'
  lastModifiedLedgerSeq?: number
}

export interface ContractStateSnapshot {
  ledgerSequence: number
  contractId: string
  timestamp: string
  entries: SorobanStorageEntry[]
  metadata: {
    exporterVersion: string
    totalEntries: number
    networkPassphrase: string
    rpcUrl: string
  }
}

// --- Cryptography & WebAuthn / Passkey Subsystem ---
export interface PasskeyCredential {
  id: string
  rawId: string
  type: 'public-key'
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string
  }
}

export interface WebAuthnVerificationResult {
  verified: boolean
  publicKeyHex?: string
  counter?: number
  userHandle?: string
  error?: string
}

export interface CryptoKeyPair {
  publicKey: string
  secretKey: string
}

export interface SignaturePayload {
  message: string
  signature: string
  publicKey: string
  algorithm: 'ed25519' | 'webauthn-p256' | 'aes-gcm'
  timestamp: number
  nonce?: string
}

export interface EncryptedData {
  ciphertext: string
  iv: string
  authTag: string
  algorithm: 'AES-GCM'
}

// --- Wallet & State Context ---
export interface WalletState {
  address: string | null
  network: string
  isConnected: boolean
  walletType: string | null
  passkeyEnabled: boolean
}

// --- Soroban Footprint Inspection (#517) ---
export interface SorobanFootprintKey {
  type: 'readOnly' | 'readWrite'
  /** Base64 xdr.LedgerKey payload (opaque in the API layer). */
  xdr: string
}

export interface SorobanFootprint {
  contractId: string
  functionName: string
  readOnly: SorobanFootprintKey[]
  readWrite: SorobanFootprintKey[]
  resourceFee: string
  footprintXdr: string
  generatedAt: number
}

export interface SorobanFootprintTemplate {
  contractId: string
  functionName: string
  argsKey: string
  readOnlyCount: number
  readWriteCount: number
  resourceFee: string
  footprintXdr: string
}

export interface SorobanFootprintCacheStats {
  size: number
  maxEntries: number
  ttlMs: number
  hits: number
  misses: number
}

export interface SorobanFootprintInspectRequest {
  contractId: string
  functionName: string
  args?: unknown[]
}

export interface SorobanFootprintInspectResponse {
  success: boolean
  template?: SorobanFootprintTemplate
  error?: string
}
// --- Client Storage Encryption ---
export interface KeyDerivationBenchmark {
  iterations: number
  runs: number
  medianMs: number
  maxMs: number
  budgetMs: number
  withinBudget: boolean
}

// --- Map Overlay Rendering ---
export type OverlayKind = 'pending' | 'enroute' | 'resolved' | 'responder'

/** A marker drawn on the community map's canvas overlay, in map (viewBox) units. */
export interface MapOverlay {
  id: string
  x: number
  y: number
  kind: OverlayKind
}

export interface OverlayRenderStats {
  fps: number
  frames: number
  windowMs: number

// ── RPC health (network estimator, #539) ─────────────────────────────────────
/** 'unknown' = no estimator registered yet. */
export type NetworkQuality = 'good' | 'degraded' | 'offline' | 'unknown';

export interface EndpointHealth {
  /** Hostname only — endpoint URLs can embed API keys and are never exposed. */
  label: string;
  /** Smoothed (EWMA) round-trip time in ms, or null before the first probe. */
  latencyMs: number | null;
  lastLatencyMs: number | null;
  healthy: boolean;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  active: boolean;
  primary: boolean;
}

export interface RpcHealthSnapshot {
  activeLabel: string;
  activeLatencyMs: number | null;
  quality: NetworkQuality;
  endpoints: EndpointHealth[];
}

// ── Image watermarking (#537) ────────────────────────────────────────────────
/** Steganographic payload embedded in an image's pixel LSBs. */
export interface WatermarkPayload {
  v: 1;
  /** Unix seconds. */
  ts: number;
  /** Random nonce (hex). */
  n: string;
  /** SHA-256 of the pixels with RGB LSBs cleared. */
  d: string;
  /** SHA-256 of `${ts}:${n}` — the cryptographic timestamp hash. */
  h: string;
  /** Optional coarse location as integer hundredths of a degree [lat, lng]. */
  loc?: [number, number];
  /** Optional help-request id. */
  rid?: string;
}

/** What the ledger stores for a registered watermark. */
export interface LedgerWatermarkRecord {
  digest: string;
  timestamp: number;
  /** Account that registered it, if the ledger records one. */
  registrant?: string;
}

export type WatermarkStatus =
  | 'authentic'
  | 'ledger-unchecked'
  | 'unregistered'
  | 'ledger-mismatch'
  | 'tampered'
  | 'corrupted'
  | 'no-watermark';

export interface WatermarkVerification {
  status: WatermarkStatus;
  payload?: WatermarkPayload;
  /** Ledger key: SHA-256 of the payload bytes. */
  id?: string;
  record?: LedgerWatermarkRecord;
}

