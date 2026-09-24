/**
 * Key Rotation Module
 *
 * Handles cryptographic key pair rotation for Stellar accounts.
 * Signs rotation certificates using both old and new private keys
 * to prove ownership during key migration.
 */
import * as StellarSdk from '@stellar/stellar-sdk';

export interface KeyRotationResult {
  success: boolean;
  oldPublicKey: string;
  newPublicKey: string;
  signedAt: number;
  certificateXdr?: string;
  error?: string;
}

export interface RotationCertificate {
  oldPublicKey: string;
  newPublicKey: string;
  timestamp: number;
  signature: Buffer;
}

/**
 * Generate a new keypair for rotation.
 */
export function generateNewKeypair(): StellarSdk.Keypair {
  return StellarSdk.Keypair.random();
}

/**
 * Create a rotation certificate signed by both old and new keys.
 * This proves ownership of both keys during the migration process.
 */
export async function createRotationCertificate(
  oldKeypair: StellarSdk.Keypair,
  newKeypair: StellarSdk.Keypair
): Promise<RotationCertificate> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Message to sign: "rotate:<old_pub>:<new_pub>:<timestamp>"
  const message = `rotate:${oldKeypair.publicKey()}:${newKeypair.publicKey()}:${timestamp}`;
  const messageBuffer = Buffer.from(message);

  // Sign with both keys
  const oldSignature = oldKeypair.sign(messageBuffer);
  const newSignature = newKeypair.sign(messageBuffer);

  // Combine signatures (old || new)
  const combinedSignature = Buffer.concat([oldSignature, newSignature]);

  return {
    oldPublicKey: oldKeypair.publicKey(),
    newPublicKey: newKeypair.publicKey(),
    timestamp,
    signature: combinedSignature,
  };
}

/**
 * Verify a rotation certificate.
 */
export function verifyRotationCertificate(
  certificate: RotationCertificate,
  oldPublicKey: string,
  newPublicKey: string
): boolean {
  const message = `rotate:${oldPublicKey}:${newPublicKey}:${certificate.timestamp}`;
  const messageBuffer = Buffer.from(message);

  try {
    const oldKeypair = StellarSdk.Keypair.fromPublicKey(oldPublicKey);
    const newKeypair = StellarSdk.Keypair.fromPublicKey(newPublicKey);

    // Split combined signature
    const oldSig = certificate.signature.slice(0, 64);
    const newSig = certificate.signature.slice(64);

    const oldValid = oldKeypair.verify(messageBuffer, oldSig);
    const newValid = newKeypair.verify(messageBuffer, newSig);

    return oldValid && newValid;
  } catch {
    return false;
  }
}

/**
 * Check if key rotation is overdue (older than maxAgeDays).
 */
export function isRotationDue(lastRotationTimestamp: number, maxAgeDays: number = 30): boolean {
  const maxAgeSeconds = maxAgeDays * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  return (now - lastRotationTimestamp) > maxAgeSeconds;
}
