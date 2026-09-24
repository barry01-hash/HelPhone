/**
 * PBKDF2 key derivation for client-side storage encryption (Web Crypto).
 *
 * A passphrase is stretched with PBKDF2-HMAC-SHA-256 (100,000 iterations) and a
 * per-device random salt into a non-extractable AES-256-GCM key. The salt is
 * not secret, but it must be stable across sessions and unique per device, so
 * it is generated once and kept in IndexedDB.
 */
import type { KeyDerivationBenchmark } from '../types';

export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_SALT_BYTES = 16;
/** Latency budget for one derivation, so app startup stays smooth. */
export const KEY_DERIVATION_BUDGET_MS = 50;

const DB_NAME = 'helphone-secure';
const STORE = 'kdf';
const SALT_KEY = 'pbkdf2-salt';

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Return this device's salt, generating and persisting one on first use. */
export async function getOrCreateSalt(): Promise<Uint8Array> {
  const db = await openDb();
  try {
    const existing = await requestToPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(SALT_KEY),
    );
    if (existing instanceof Uint8Array && existing.length === PBKDF2_SALT_BYTES) return existing;

    const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(salt, SALT_KEY));
    return salt;
  } finally {
    db.close();
  }
}

/** Derive a non-extractable AES-256-GCM key from a passphrase and salt. */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  if (!passphrase) throw new Error('A passphrase is required to derive a storage key');
  if (salt.length < PBKDF2_SALT_BYTES) throw new Error(`Salt must be at least ${PBKDF2_SALT_BYTES} bytes`);
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Derive the storage key for this device (salt loaded or created in IndexedDB). */
export async function deriveStorageKey(passphrase: string): Promise<CryptoKey> {
  return deriveKey(passphrase, await getOrCreateSalt());
}

/**
 * Time key derivation. Reports the median and worst latency over `runs` and
 * whether the median is within KEY_DERIVATION_BUDGET_MS. `now` is injectable so
 * the budget logic is testable without depending on hardware speed.
 */
export async function benchmarkKeyDerivation(
  runs = 3,
  now: () => number = () => performance.now(),
  budgetMs = KEY_DERIVATION_BUDGET_MS,
): Promise<KeyDerivationBenchmark> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const samples: number[] = [];
  for (let i = 0; i < Math.max(1, runs); i++) {
    const start = now();
    await deriveKey('benchmark-passphrase', salt);
    samples.push(now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  return {
    iterations: PBKDF2_ITERATIONS,
    runs: samples.length,
    medianMs,
    maxMs: sorted[sorted.length - 1],
    budgetMs,
    withinBudget: medianMs <= budgetMs,
  };
}

/**
 * Run the benchmark once the browser is idle and warn if derivation is slow.
 * Never throws and never blocks startup.
 */
export function scheduleKeyDerivationBenchmark(): void {
  const run = () => {
    benchmarkKeyDerivation()
      .then((r) => {
        if (!r.withinBudget) {
          console.warn(
            `[pbkdf2] key derivation median ${r.medianMs.toFixed(1)}ms exceeds ${r.budgetMs}ms budget on this device`,
          );
        }
      })
      .catch(() => {});
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (typeof idle === 'function') idle(run);
  else setTimeout(run, 1_000);
}
