/**
 * Encrypted localStorage. Values are sealed with AES-256-GCM under a key
 * derived from the user's passphrase (see pbkdf2Key.ts), so nothing sensitive
 * sits in plaintext in browser storage.
 *
 * Stored format: JSON `{ v: 1, iv: <base64>, ct: <base64> }` under
 * `hp_secure:<key>`. AES-GCM authenticates the ciphertext, so a wrong
 * passphrase or a tampered value is rejected instead of yielding garbage.
 */
import { deriveStorageKey } from './pbkdf2Key';

const PREFIX = 'hp_secure:';
const VERSION = 1;

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class SecureStorage {
  private key: CryptoKey | null = null;

  constructor(private readonly storage: Storage = globalThis.localStorage) {}

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Derive the key from a passphrase. Must be called before get/set. */
  async unlock(passphrase: string): Promise<void> {
    this.key = await deriveStorageKey(passphrase);
  }

  /** Drop the in-memory key. */
  lock(): void {
    this.key = null;
  }

  private requireKey(): CryptoKey {
    if (!this.key) throw new Error('Secure storage is locked');
    return this.key;
  }

  async setItem(name: string, value: string): Promise<void> {
    const key = this.requireKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)),
    );
    this.storage.setItem(PREFIX + name, JSON.stringify({ v: VERSION, iv: toBase64(iv), ct: toBase64(ct) }));
  }

  /** Returns null if the entry is absent. Throws if it cannot be decrypted. */
  async getItem(name: string): Promise<string | null> {
    const key = this.requireKey();
    const raw = this.storage.getItem(PREFIX + name);
    if (raw === null) return null;
    let parsed: { v?: number; iv?: string; ct?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Secure storage entry is corrupted');
    }
    if (parsed.v !== VERSION || !parsed.iv || !parsed.ct) {
      throw new Error('Secure storage entry has an unsupported format');
    }
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(parsed.iv) as BufferSource },
        key,
        fromBase64(parsed.ct) as BufferSource,
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new Error('Could not decrypt secure storage entry (wrong passphrase or tampered data)');
    }
  }

  removeItem(name: string): void {
    this.storage.removeItem(PREFIX + name);
  }
}
