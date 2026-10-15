import { eq } from 'drizzle-orm';
import type { Request, RequestHandler } from 'express';
import type { Db } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { AppError } from '../errors/app-error.js';
import { hashApiKey } from '../lib/api-key.js';

export interface AuthenticatedAccount {
  id: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireApiKey. Read it through accountOf(req). */
    account?: AuthenticatedAccount;
  }
}

/**
 * Hashes the X-API-Key header and looks the account up by that hash (unique index).
 * Missing or unknown key → 401. The comparison happens on the hash, so response timing
 * can't reveal anything about a stored key.
 */
export function requireApiKey(db: Db): RequestHandler {
  return async (req, _res, next) => {
    const key = req.get('x-api-key');
    if (!key) {
      throw new AppError('UNAUTHORIZED', 'Missing X-API-Key header');
    }
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.apiKeyHash, hashApiKey(key)));
    if (!account) {
      throw new AppError('UNAUTHORIZED', 'Invalid API key');
    }
    req.account = account;
    next();
  };
}

/** The calling account. Only valid on routes behind requireApiKey. */
export function accountOf(req: Request): AuthenticatedAccount {
  if (!req.account) {
    throw new Error('accountOf called on a route without requireApiKey');
  }
  return req.account;
}
