import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' });
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
  });

  it('coerces PORT', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', PORT: '8080' });
    expect(config.PORT).toBe(8080);
  });
});

describe('loadConfig validation', () => {
  const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

  it('accepts the postgresql:// scheme', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }).DATABASE_URL).toBe(
      'postgresql://u:p@localhost:5432/db',
    );
  });

  it('rejects a DATABASE_URL that is not a URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });

  it.each(['0', '65536', '80.5', 'abc'])('rejects PORT=%s', (PORT) => {
    expect(() => loadConfig({ DATABASE_URL, PORT })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('lists every problem in one error', () => {
    expect(() => loadConfig({ PORT: 'abc', NODE_ENV: 'staging' })).toThrow(
      /DATABASE_URL[\s\S]*PORT[\s\S]*NODE_ENV/,
    );
  });
});
