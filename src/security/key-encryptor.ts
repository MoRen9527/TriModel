// ── TriModel Key Encryptor (S2): AES-256-GCM + PBKDF2 machine fingerprint ──
//
// Phase 2 S2 security level:
//   - Key encryption using AES-256-GCM with random IV
//   - Key derivation via PBKDF2-HMAC-SHA256 from machine fingerprint
//   - Even if keys.json is copied to another machine, it cannot be decrypted
//
// Machine fingerprint: hostname() + username + platform() + arch()
// Salt: compile-time constant (32 bytes, hex-encoded)
// PBKDF2 iterations: 100,000

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { hostname, userInfo, platform, arch } from 'node:os';

// Compile-time constant salt (32 bytes, hex-encoded)
const FIXED_SALT = Buffer.from(
  '7a3f8c2e1b4d5f6a9c8e7d3f2a1b4c5d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b',
  'hex',
);

/**
 * Derive a machine-specific fingerprint string.
 * Falls back gracefully in restricted environments.
 */
function deriveMachineFingerprint(): string {
  try {
    return `${hostname()}:${userInfo().username}:${platform()}:${arch()}`;
  } catch {
    // Fallback for restricted environments (e.g., containers without full OS info)
    return `unknown:${platform()}:${arch()}`;
  }
}

/**
 * Derive a 256-bit AES key from the machine fingerprint using PBKDF2.
 */
function deriveKey(): Buffer {
  const fingerprint = deriveMachineFingerprint();
  return pbkdf2Sync(fingerprint, FIXED_SALT, 100_000, 32, 'sha256');
}

/**
 * Encrypt plaintext using AES-256-GCM with random IV.
 * Output format: [12 bytes IV][encrypted payload][16 bytes GCM auth tag]
 */
export function encrypt(plaintext: string): Buffer {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Decrypt ciphertext that was encrypted with encrypt().
 * Format: [12 bytes IV][encrypted payload][16 bytes GCM auth tag]
 */
export function decrypt(ciphertext: Buffer): string {
  const iv = ciphertext.subarray(0, 12);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(12, ciphertext.length - 16);
  const key = deriveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

/**
 * Heuristic check: is the provided data in encrypted format?
 *
 * Encrypted format has [12 bytes IV][...][16 bytes tag], min 28 bytes total.
 * Plaintext JSON always starts with '{' (0x7b).
 * Encrypted data starts with random IV bytes (not '{').
 */
export function isEncryptedFormat(data: Buffer): boolean {
  return data.length > 28 && data[0] !== 0x7b; // 0x7b = '{'
}

/**
 * Check whether key derivation is possible in the current environment.
 * Returns false in extreme cases where crypto or OS primitives are unavailable.
 */
export function canDeriveKey(): boolean {
  try {
    deriveKey();
    return true;
  } catch {
    return false;
  }
}
