// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_BYTES,
  KEY_DERIVATION_BUDGET_MS,
  getOrCreateSalt,
  deriveKey,
  deriveStorageKey,
  benchmarkKeyDerivation,
  scheduleKeyDerivationBenchmark,
} from '../src/lib/pbkdf2Key.ts';
import { SecureStorage } from '../src/lib/secureStorage.ts';
import { helpStore, upsertOfflineHelp, persistHelpStore, hydrateHelpStore } from '../src/stores/helpStore.ts';
import { LwwElementSet } from '../src/lib/crdt.ts';

class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
}

const encryptWith = async (key, text) => {
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return new Uint8Array(ct);
};

describe('constants', () => {
  it('uses 100,000 iterations, a 16-byte salt and a 50ms budget', () => {
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(PBKDF2_SALT_BYTES).toBe(16);
    expect(KEY_DERIVATION_BUDGET_MS).toBe(50);
  });
});

describe('getOrCreateSalt', () => {
  beforeEach(() => { indexedDB = new IDBFactory(); });

  it('generates a random 16-byte salt', async () => {
    const salt = await getOrCreateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt).toHaveLength(16);
  });

  it('persists the salt so later calls return the same value', async () => {
    const a = await getOrCreateSalt();
    const b = await getOrCreateSalt();
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('generates a different salt on a fresh device', async () => {
    const a = await getOrCreateSalt();
    indexedDB = new IDBFactory();
    const b = await getOrCreateSalt();
    expect(Array.from(b)).not.toEqual(Array.from(a));
  });

  it('replaces a stored salt that has the wrong shape', async () => {
    const open = indexedDB.open('helphone-secure', 1);
    const db = await new Promise((res, rej) => {
      open.onupgradeneeded = () => open.result.createObjectStore('kdf');
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    await new Promise((res) => {
      const tx = db.transaction('kdf', 'readwrite');
      tx.objectStore('kdf').put(new Uint8Array(3), 'pbkdf2-salt');
      tx.oncomplete = res;
    });
    db.close();
    expect(await getOrCreateSalt()).toHaveLength(16);
  });
});

describe('deriveKey', () => {
  const salt = new Uint8Array(16).fill(7);

  it('produces a non-extractable AES-256-GCM key', async () => {
    const key = await deriveKey('correct horse', salt);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('is deterministic for the same passphrase and salt', async () => {
    const a = await encryptWith(await deriveKey('pw', salt), 'hello');
    const b = await encryptWith(await deriveKey('pw', salt), 'hello');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs by passphrase and by salt', async () => {
    const base = await encryptWith(await deriveKey('pw', salt), 'hello');
    const otherPw = await encryptWith(await deriveKey('pw2', salt), 'hello');
    const otherSalt = await encryptWith(await deriveKey('pw', new Uint8Array(16).fill(8)), 'hello');
    expect(Array.from(otherPw)).not.toEqual(Array.from(base));
    expect(Array.from(otherSalt)).not.toEqual(Array.from(base));
  });

  it('rejects an empty passphrase and a short salt', async () => {
    await expect(deriveKey('', salt)).rejects.toThrow(/passphrase/);
    await expect(deriveKey('pw', new Uint8Array(8))).rejects.toThrow(/Salt/);
  });

  it('deriveStorageKey uses the persisted device salt', async () => {
    indexedDB = new IDBFactory();
    const a = await encryptWith(await deriveStorageKey('pw'), 'x');
    const b = await encryptWith(await deriveStorageKey('pw'), 'x');
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('benchmarkKeyDerivation', () => {
  it('reports median, max and iteration count', async () => {
    const r = await benchmarkKeyDerivation(3);
    expect(r.iterations).toBe(100_000);
    expect(r.runs).toBe(3);
    expect(r.medianMs).toBeGreaterThan(0);
    expect(r.maxMs).toBeGreaterThanOrEqual(r.medianMs);
    expect(r.budgetMs).toBe(50);
  });

  it('flags within-budget vs over-budget using an injected clock', async () => {
    const clock = (step) => { let t = 0; let n = 0; return () => (n++ % 2 === 0 ? t : (t += step)); };
    expect((await benchmarkKeyDerivation(3, clock(20))).withinBudget).toBe(true);
    expect((await benchmarkKeyDerivation(3, clock(80))).withinBudget).toBe(false);
    expect((await benchmarkKeyDerivation(1, clock(50))).withinBudget).toBe(true);
  });

  it('always runs at least once', async () => {
    expect((await benchmarkKeyDerivation(0)).runs).toBe(1);
  });
});

describe('scheduleKeyDerivationBenchmark', () => {
  it('warns when the device is over budget and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Strictly monotonic so any interleaved caller (e.g. vitest itself) can't skew the sample.
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 500));
    vi.stubGlobal('requestIdleCallback', (cb) => cb());
    scheduleKeyDerivationBenchmark();
    // Three real PBKDF2 derivations run before the warning; allow for a slow or busy CI runner.
    await vi.waitFor(
      () => expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds 50ms budget')),
      { timeout: 20_000 },
    );
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back to a timer without requestIdleCallback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scheduleKeyDerivationBenchmark();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warn.mockRestore();
  });
});

describe('SecureStorage', () => {
  let store;
  let backing;
  beforeEach(() => {
    indexedDB = new IDBFactory();
    backing = new MemoryStorage();
    store = new SecureStorage(backing);
  });

  it('is locked until unlocked and can be locked again', async () => {
    expect(store.unlocked).toBe(false);
    await expect(store.setItem('a', 'b')).rejects.toThrow(/locked/);
    await expect(store.getItem('a')).rejects.toThrow(/locked/);
    await store.unlock('pw');
    expect(store.unlocked).toBe(true);
    store.lock();
    expect(store.unlocked).toBe(false);
  });

  it('round-trips a value and never stores plaintext', async () => {
    await store.unlock('pw');
    await store.setItem('profile', 'nickname=alice');
    const raw = backing.getItem('hp_secure:profile');
    expect(raw).not.toContain('alice');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect(await store.getItem('profile')).toBe('nickname=alice');
  });

  it('uses a fresh IV per write', async () => {
    await store.unlock('pw');
    await store.setItem('k', 'same');
    const a = JSON.parse(backing.getItem('hp_secure:k')).iv;
    await store.setItem('k', 'same');
    const b = JSON.parse(backing.getItem('hp_secure:k')).iv;
    expect(a).not.toBe(b);
  });

  it('returns null for a missing key', async () => {
    await store.unlock('pw');
    expect(await store.getItem('nope')).toBeNull();
  });

  it('rejects a wrong passphrase', async () => {
    await store.unlock('right');
    await store.setItem('k', 'secret');
    const other = new SecureStorage(backing);
    await other.unlock('wrong');
    await expect(other.getItem('k')).rejects.toThrow(/wrong passphrase or tampered/);
  });

  it('rejects tampered ciphertext', async () => {
    await store.unlock('pw');
    await store.setItem('k', 'secret');
    const entry = JSON.parse(backing.getItem('hp_secure:k'));
    entry.ct = entry.ct.slice(0, -4) + 'AAAA';
    backing.setItem('hp_secure:k', JSON.stringify(entry));
    await expect(store.getItem('k')).rejects.toThrow(/tampered/);
  });

  it('rejects corrupted and unsupported entries', async () => {
    await store.unlock('pw');
    backing.setItem('hp_secure:bad', '{not json');
    await expect(store.getItem('bad')).rejects.toThrow(/corrupted/);
    backing.setItem('hp_secure:old', JSON.stringify({ v: 99, iv: 'a', ct: 'b' }));
    await expect(store.getItem('old')).rejects.toThrow(/unsupported/);
    backing.setItem('hp_secure:partial', JSON.stringify({ v: 1 }));
    await expect(store.getItem('partial')).rejects.toThrow(/unsupported/);
  });

  it('removes entries', async () => {
    await store.unlock('pw');
    await store.setItem('k', 'v');
    store.removeItem('k');
    expect(await store.getItem('k')).toBeNull();
  });
});

describe('helpStore persistence', () => {
  it('persists encrypted and hydrates into a fresh store', async () => {
    indexedDB = new IDBFactory();
    const backing = new MemoryStorage();
    const secure = new SecureStorage(backing);
    await secure.unlock('pw');

    upsertOfflineHelp('req-1', { status: 'Pending', lat: 6.5, lng: 3.4, updatedAt: 100 });
    await persistHelpStore(secure);
    expect(backing.getItem('hp_secure:help-store')).not.toContain('6.5');

    const fresh = new LwwElementSet('other');
    expect(await hydrateHelpStore(secure, fresh)).toBe(true);
    expect(fresh.values()).toEqual([['req-1', { status: 'Pending', lat: 6.5, lng: 3.4, updatedAt: 100 }]]);
    expect(helpStore.values().length).toBeGreaterThan(0);
  });

  it('hydrate returns false when nothing was persisted', async () => {
    indexedDB = new IDBFactory();
    const secure = new SecureStorage(new MemoryStorage());
    await secure.unlock('pw');
    expect(await hydrateHelpStore(secure, new LwwElementSet('x'))).toBe(false);
  });
});
