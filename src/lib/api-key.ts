import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mk_';

/** What generateApiKey() produces: the prefix and 32 bytes as unpadded base64url (43 characters). */
const API_KEY_FORMAT = /^mk_[A-Za-z0-9_-]{43}$/;

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

/**
 * True if `key` has the shape of a key generateApiKey() could have issued. Anything else can't
 * match a stored hash, so auth rejects it without hashing it or querying the database. The format
 * is public (it's in the README), so failing fast on it reveals nothing about any stored key.
 */
export function isWellFormedApiKey(key: string): boolean {
  return API_KEY_FORMAT.test(key);
}
