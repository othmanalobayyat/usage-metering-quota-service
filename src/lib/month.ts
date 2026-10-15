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
