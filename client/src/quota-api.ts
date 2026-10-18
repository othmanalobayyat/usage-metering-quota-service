/** Thin client for the quota service. Every call goes server-to-server, so the API needs no CORS. */

export type Status = 'ACCEPTED' | 'REJECTED';
export type ReasonCode = 'PER_REQUEST_LIMIT_EXCEEDED' | 'MONTHLY_LIMIT_EXCEEDED';
export type RuleOwner = 'ACCOUNT' | 'USER';

export interface Plan {
  id: string;
  name: string;
  type: RuleOwner;
  monthlyLimit: number;
  perRequestLimit: number;
  predefined: boolean;
}

export interface Account {
  id: string;
  name: string;
  apiKey: string;
  plan: Plan;
}

export interface User {
  externalUserId: string;
  name: string | null;
  plan: Plan;
}

export interface Decision {
  requestId: string;
  status: Status;
  reasonCode: ReasonCode | null;
  rejectedBy: RuleOwner | null;
  limit: number | null;
  remaining: { account: number; user: number };
  replayed: boolean;
}

/** A non-2xx answer from the API, carrying its `{ error: { code, message } }` body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 10_000;

export class QuotaApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** The same client, authenticated as the account that owns `apiKey`. */
  withKey(apiKey: string): QuotaApi {
    return new QuotaApi(this.baseUrl, apiKey);
  }

  createAccount(name: string): Promise<Account> {
    return this.call('POST', '/accounts', { name });
  }

  createPlan(input: { name: string; type: RuleOwner; monthlyLimit: number; perRequestLimit: number }): Promise<Plan> {
    return this.call('POST', '/plans', input);
  }

  async listPlans(type: RuleOwner): Promise<Plan[]> {
    const page = await this.call<{ data: Plan[] }>('GET', `/plans?type=${type}`);
    return page.data;
  }

  setAccountPlan(planId: string): Promise<{ plan: Plan }> {
    return this.call('PUT', '/account/plan', { planId });
  }

  registerUser(input: { externalUserId: string; name?: string; planId?: string }): Promise<User> {
    return this.call('POST', '/users', input);
  }

  setUserPlan(externalUserId: string, planId: string): Promise<User> {
    return this.call('PUT', `/users/${encodeURIComponent(externalUserId)}/plan`, { planId });
  }

  consume(input: { externalUserId: string; units: number; requestId: string }): Promise<Decision> {
    return this.call('POST', '/consume', input);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, error?.code ?? `HTTP_${res.status}`, error?.message ?? `${method} ${path} failed`);
    }
    return json as T;
  }
}
