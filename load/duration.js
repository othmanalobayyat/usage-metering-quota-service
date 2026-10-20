// DURATION for the k6 scenarios. No k6 imports, so tests/load-duration.test.ts can import it.
// Only whole seconds (20s, 30s, 90s) are accepted. k6 itself also takes 1m30s or 500ms, but the
// summary divides by this number for req/s, and parseFloat('1m') is 1, so other formats are refused
// instead of misread. load/run.sh checks the same pattern before it starts anything.
const WHOLE_SECONDS = /^([1-9][0-9]*)s$/;

/** `'30s'` → 30. Throws for anything that isn't whole seconds. */
export function durationSeconds(value) {
  const match = WHOLE_SECONDS.exec(value);
  if (!match) throw new Error(`DURATION must be whole seconds such as 30s or 90s, got "${value}"`);
  return Number(match[1]);
}
