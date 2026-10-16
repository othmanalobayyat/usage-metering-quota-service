# Assumptions 

Behavior that docs/PLAN.md §4 leaves unspecified, with the reason for each choice.

- **List response shape:** lists return `{ data: [...] }`, and paginated lists add `nextCursor` (`null` on the last page). One envelope everywhere leaves room to add fields without breaking clients.
- **Page size:** `GET /users` returns 20 per page by default and allows `limit` from 1 to 100. The cap bounds each query's cost, and 20 is a common default.
- **Plan ordering:** `GET /plans` lists predefined plans first in seed order (Starter, Pro, Basic, Premium), then the account's custom plans oldest first. The ordering is stable and puts the well-known plans on top.
- **`predefined` flag:** every plan includes `predefined: boolean`, derived from `account_id IS NULL`. Callers need to know which plans are read-only, and deriving the flag means it can't drift from the column.
- **Usage shape:** `GET /account` and `GET /users/:externalUserId` include `usage: { month: "YYYY-MM", consumed, remaining }` for the current UTC month. A missing usage row reads as 0 and `remaining = max(0, monthlyLimit - consumed)`, which matches the "reads never create rows" rule.
- **Malformed IDs in the URL → 404:** a non-UUID plan ID or an `externalUserId` longer than 128 characters can't name an existing resource, so it returns 404 like any other unknown resource (a malformed `planId` in a body is still 400).
- **Unknown body fields → 400:** bodies are strict, so typos and read-only fields (such as `type` on PATCH) fail loudly instead of being silently ignored.
- **Unknown query params are ignored:** clients and proxies often add extra params (such as cache-busters), and ignoring them is harmless for reads.
- **Body-parser errors → 400:** malformed JSON, an oversized body, or a bad charset returns 400 `VALIDATION_ERROR`, because §4 maps invalid bodies to that one code (an oversized body would otherwise be a 413).
- **User `remaining` uses the user's plan only:** the user view reports the user's own allowance, while the account view reports the shared allowance. Mixing the two would hide which limit applies.
- **Custom plans may reuse predefined names:** uniqueness is per owner (`UNIQUE NULLS NOT DISTINCT (account_id, name)`), so an account may create its own "Starter". Plans are always referenced by ID, so a name collision is never ambiguous.
- **A monthly limit of 0 blocks all requests (it does not mean unlimited):** the schema allows `monthly_limit >= 0`, and the monthly rule accepts only when `used + units <= monthlyLimit`, so a limit of 0 rejects every request (units are always at least 1). Reading 0 as "unlimited" would need a special case in every rule and in every `remaining` calculation, and it would turn a typo or an unset value into unlimited usage. A 0 limit is also useful on purpose, for example to suspend a user or account without deleting anything.
