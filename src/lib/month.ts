/**
 * The usage month an instant belongs to, as 'YYYY-MM-01' (the `month` date column).
 * Months are UTC: the server's time zone never matters. Every month calculation goes through here.
 */
export function toUtcMonth(date: Date): string {
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new RangeError('toUtcMonth: invalid date');
  }
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError(`toUtcMonth: year ${year} is outside 0001-9999`);
  }
  const month = date.getUTCMonth() + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Parses a `YYYY-MM` query value (years 0001-9999) into the first instant of that UTC month,
 * or undefined if it isn't one. Callers still pass the result through toUtcMonth().
 */
export function parseYearMonth(raw: string): Date | undefined {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw);
  if (!match) return undefined;
  const year = Number(match[1]);
  if (year < 1) return undefined;
  const date = new Date(0);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999.
  date.setUTCFullYear(year, Number(match[2]) - 1, 1);
  return date;
}
