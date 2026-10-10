const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Parse a duration like "30m", "12h", "7d", "2w" into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhdw])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}": use a number and a unit (s, m, h, d, w), e.g. "7d"`);
  }
  return Number(match[1]) * UNITS[match[2]];
}
