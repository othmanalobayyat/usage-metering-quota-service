import { describe, expect, it } from 'vitest';
import { externalUserIdSchema, nameSchema, pageCursorSchema, requestIdSchema } from '../src/lib/schemas.js';

// Ill-formed UTF-16 is rejected like NUL, and well-formed text, U+FFFD included, is accepted
// unchanged.

/** Set S: every shape of lone surrogate (first, last, embedded, reversed, after a valid pair). */
const ILL_FORMED: [label: string, value: string][] = [
  ['lone high \\ud800', '\ud800'],
  ['lone low \\udfff', '\udfff'],
  ['lone low \\udc00', '\udc00'],
  ['embedded high a\\udbffb', 'a\udbffb'],
  ['reversed pair \\ude00\\ud83d', '\ude00\ud83d'],
  ['pair then lone high 👍\\ud83d', '👍\ud83d'],
];

/** Set W: well-formed non-ASCII text the fix must keep accepting, U+FFFD included. */
const WELL_FORMED: [label: string, value: string][] = [
  ['👍', '👍'],
  ['😀 as an escaped pair', '\ud83d\ude00'],
  ['U+FFFD', '\ufffd'],
  ['é precomposed', '\u00e9'],
  ['e\u0301 combining', 'e\u0301'],
  ['用户-42', '用户-42'],
  ['مستخدم', 'مستخدم'],
  ['👩‍💻 ZWJ sequence', '👩\u200d💻'],
  ['🇵🇸 flag', '🇵🇸'],
  ['𝔘ser non-BMP letter', '𝔘ser'],
];

describe('F10: ill-formed UTF-16 in caller-supplied strings', () => {
  // Sanity: the sample sets are what they claim to be.
  it('set S is ill-formed and set W is well-formed', () => {
    // A lone surrogate is one not part of a high+low pair (the `u` flag matches whole pairs).
    const loneSurrogate = /\p{Surrogate}/u;
    for (const [, v] of ILL_FORMED) expect(v).toMatch(loneSurrogate);
    for (const [, v] of WELL_FORMED) expect(v).not.toMatch(loneSurrogate);
  });

  describe('TP-UNIT-01: externalUserIdSchema and requestIdSchema reject set S', () => {
    it.each(ILL_FORMED)('%s', (_label, value) => {
      expect(externalUserIdSchema.safeParse(value).success).toBe(false);
      expect(requestIdSchema.safeParse(value).success).toBe(false);
    });
  });

  describe('TP-UNIT-02: nameSchema and pageCursorSchema reject set S', () => {
    it.each(ILL_FORMED)('%s', (_label, value) => {
      expect(nameSchema.safeParse(value).success).toBe(false);
      // Trimming doesn't remove a lone surrogate.
      expect(nameSchema.safeParse(` ${value} `).success).toBe(false);
      expect(pageCursorSchema.safeParse(value).success).toBe(false);
    });
  });

  describe('TP-UNIT-03: all four schemas accept set W unchanged', () => {
    it.each(WELL_FORMED)('%s', (_label, value) => {
      expect(externalUserIdSchema.parse(value)).toBe(value);
      expect(requestIdSchema.parse(value)).toBe(value);
      expect(pageCursorSchema.parse(value)).toBe(value);
      expect(nameSchema.parse(value)).toBe(value);
      expect(nameSchema.parse(`  ${value}  `)).toBe(value);
    });
  });

  it('TP-UNIT-04: NUL is still rejected with its own message, alone or next to a lone surrogate', () => {
    for (const value of ['\u0000\ud800', '\u0000']) {
      const result = requestIdSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toContain('must not contain NUL characters');
    }
  });
});
