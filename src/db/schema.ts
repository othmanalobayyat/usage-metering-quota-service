import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Data model: docs/PLAN.md §3. Timestamps have no DB default on purpose: they are written
// from the injected clock (lib/clock.ts) so tests control time.

export const planType = pgEnum('plan_type', ['ACCOUNT', 'USER']);
export const requestStatus = pgEnum('request_status', ['ACCEPTED', 'REJECTED']);
export const reasonCode = pgEnum('reason_code', [
  'PER_REQUEST_LIMIT_EXCEEDED',
  'MONTHLY_LIMIT_EXCEEDED',
]);
export const ruleOwner = pgEnum('rule_owner', ['ACCOUNT', 'USER']);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** First day of a UTC month as 'YYYY-MM-01', produced by toUtcMonth(). */
const month = () => date('month', { mode: 'string' }).notNull();

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = predefined. Lazy reference because accounts.plan_id points back here.
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    name: text('name').notNull(),
    type: planType('type').notNull(),
    monthlyLimit: integer('monthly_limit').notNull(),
    perRequestLimit: integer('per_request_limit').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    unique('plans_account_id_name_unique').on(t.accountId, t.name).nullsNotDistinct(),
    check('plans_monthly_limit_check', sql`${t.monthlyLimit} >= 0`),
    check('plans_per_request_limit_check', sql`${t.perRequestLimit} > 0`),
  ],
);

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKeyHash: char('api_key_hash', { length: 64 }).notNull().unique(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  createdAt: timestamptz('created_at').notNull(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    externalUserId: text('external_user_id').notNull(),
    name: text('name'),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    createdAt: timestamptz('created_at').notNull(),
  },
  (t) => [
    unique('users_account_id_external_user_id_unique').on(t.accountId, t.externalUserId),
    // Target for the composite FKs from user_usage and requests.
    unique('users_account_id_id_unique').on(t.accountId, t.id),
    index('users_account_id_created_at_id_idx').on(t.accountId, t.createdAt, t.id),
  ],
);

export const accountUsage = pgTable(
  'account_usage',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    month: month(),
    unitsUsed: integer('units_used').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.month] }),
    check('account_usage_month_check', sql`EXTRACT(DAY FROM ${t.month}) = 1`),
    check('account_usage_units_used_check', sql`${t.unitsUsed} >= 0`),
  ],
);

export const userUsage = pgTable(
  'user_usage',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    month: month(),
    unitsUsed: integer('units_used').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.month] }),
    // A usage row can never point at another account's user.
    foreignKey({
      name: 'user_usage_account_id_user_id_users_fk',
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.id],
    }),
    check('user_usage_month_check', sql`EXTRACT(DAY FROM ${t.month}) = 1`),
    check('user_usage_units_used_check', sql`${t.unitsUsed} >= 0`),
  ],
);

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    userId: uuid('user_id').notNull(),
    requestId: text('request_id').notNull(),
    units: integer('units').notNull(),
    month: month(),
    status: requestStatus('status').notNull(),
    reasonCode: reasonCode('reason_code'),
    rejectedBy: ruleOwner('rejected_by'),
    limitValue: integer('limit_value'),
    accountPlanId: uuid('account_plan_id')
      .notNull()
      .references(() => plans.id),
    userPlanId: uuid('user_plan_id')
      .notNull()
      .references(() => plans.id),
    remainingAccount: integer('remaining_account').notNull(),
    remainingUser: integer('remaining_user').notNull(),
    // Decision snapshot (migration 0001): the limits evaluate() was given and the usage before
    // this request, so the decision can be re-derived after the plan is edited. NULL only on rows
    // written before 0001; requests_snapshot_check makes the six all-or-nothing.
    accountMonthlyLimit: integer('account_monthly_limit'),
    accountPerRequestLimit: integer('account_per_request_limit'),
    accountUsedBefore: integer('account_used_before'),
    userMonthlyLimit: integer('user_monthly_limit'),
    userPerRequestLimit: integer('user_per_request_limit'),
    userUsedBefore: integer('user_used_before'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (t) => [
    // requestId is scoped per account; the 23505 source in the consume safety net.
    unique('requests_account_id_request_id_unique').on(t.accountId, t.requestId),
    foreignKey({
      name: 'requests_account_id_user_id_users_fk',
      columns: [t.accountId, t.userId],
      foreignColumns: [users.accountId, users.id],
    }),
    check('requests_units_check', sql`${t.units} > 0`),
    check('requests_month_check', sql`EXTRACT(DAY FROM ${t.month}) = 1`),
    check('requests_remaining_account_check', sql`${t.remainingAccount} >= 0`),
    check('requests_remaining_user_check', sql`${t.remainingUser} >= 0`),
    check(
      'requests_status_decision_check',
      sql`(
        ${t.status} = 'ACCEPTED'
        AND ${t.reasonCode} IS NULL
        AND ${t.rejectedBy} IS NULL
        AND ${t.limitValue} IS NULL
      ) OR (
        ${t.status} = 'REJECTED'
        AND ${t.reasonCode} IS NOT NULL
        AND ${t.rejectedBy} IS NOT NULL
        AND ${t.limitValue} IS NOT NULL
      )`,
    ),
    // IS NOT NULL is spelled out in the second branch: a comparison with NULL is NULL, which a
    // CHECK lets through, so `>= 0` alone would accept a row with only some snapshot columns set.
    check(
      'requests_snapshot_check',
      sql`(
        ${t.accountMonthlyLimit} IS NULL
        AND ${t.accountPerRequestLimit} IS NULL
        AND ${t.accountUsedBefore} IS NULL
        AND ${t.userMonthlyLimit} IS NULL
        AND ${t.userPerRequestLimit} IS NULL
        AND ${t.userUsedBefore} IS NULL
      ) OR (
        ${t.accountMonthlyLimit} IS NOT NULL AND ${t.accountMonthlyLimit} >= 0
        AND ${t.accountPerRequestLimit} IS NOT NULL AND ${t.accountPerRequestLimit} > 0
        AND ${t.accountUsedBefore} IS NOT NULL AND ${t.accountUsedBefore} >= 0
        AND ${t.userMonthlyLimit} IS NOT NULL AND ${t.userMonthlyLimit} >= 0
        AND ${t.userPerRequestLimit} IS NOT NULL AND ${t.userPerRequestLimit} > 0
        AND ${t.userUsedBefore} IS NOT NULL AND ${t.userUsedBefore} >= 0
      )`,
    ),
    // History indexes. NULLS FIRST is Postgres' default for DESC; Drizzle otherwise emits
    // NULLS LAST, which a plain `ORDER BY created_at DESC, id DESC` can't use without a Sort.
    index('requests_account_id_created_at_id_idx').on(
      t.accountId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('requests_account_id_month_created_at_id_idx').on(
      t.accountId,
      t.month,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('requests_account_id_user_id_created_at_id_idx').on(
      t.accountId,
      t.userId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);
