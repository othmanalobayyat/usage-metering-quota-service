import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';

/** What every service needs: the database and the injected clock. */
export interface ServiceDeps {
  db: Db;
  now: Clock;
}
