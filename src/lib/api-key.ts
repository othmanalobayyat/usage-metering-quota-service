import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mk_';

/** A new plaintext API key: `mk_` + 32 random bytes (base64url). Shown to the caller once, never stored. */
export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Hex SHA-256 of a key, as stored in accounts.api_key_hash. A fast hash is enough: the key
 * has 256 bits of entropy, so there is nothing to brute-force, and bcrypt on every request
 * would dominate the load test.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
