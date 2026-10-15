import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors/app-error.js';
import { generateApiKey, hashApiKey } from '../src/lib/api-key.js';
import { decodeCursor, encodeCursor } from '../src/lib/cursor.js';

describe('API keys', () => {
  it('are mk_ + 32 random bytes (base64url)', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^mk_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice(3), 'base64url')).toHaveLength(32);
    expect(generateApiKey()).not.toBe(key);
  });

  it('hash to 64 hex chars of SHA-256', () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(createHash('sha256').update(key).digest('hex'));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cursor', () => {
  it('round-trips (createdAt, id)', () => {
    const cursor = { createdAt: new Date('2026-10-15T12:34:56.789Z'), id: '0b6e4c1a-9a0c-4c43-a8d2-0d6f6f1c2b3a' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each(['garbage', '', Buffer.from('["not-a-date","x"]').toString('base64url'), Buffer.from('{}').toString('base64url')])(
    'rejects %j with VALIDATION_ERROR',
    (raw) => {
      expect(() => decodeCursor(raw)).toThrow(AppError);
      try {
        decodeCursor(raw);
      } catch (err) {
        expect((err as AppError).code).toBe('VALIDATION_ERROR');
      }
    },
  );
});
