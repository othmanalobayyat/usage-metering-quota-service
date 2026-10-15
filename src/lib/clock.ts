/**
 * Source of "now". Services take a Clock instead of calling `new Date()` so tests can
 * pin time or move it across a month boundary.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
