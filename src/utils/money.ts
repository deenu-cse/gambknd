/**
 * Token amounts are integers in minor units everywhere: 1 token = 100 units.
 * Floats never touch balances, stakes or payouts.
 */
export const UNITS_PER_TOKEN = 100;

export function tokensToUnits(tokens: number): number {
  const units = Math.round(tokens * UNITS_PER_TOKEN);
  assertUnits(units);
  return units;
}

export function assertUnits(units: number, label = 'amount'): void {
  if (!Number.isSafeInteger(units)) throw new TypeError(`${label} must be a safe integer of minor units, got ${units}`);
}

export function assertPositiveUnits(units: number, label = 'amount'): void {
  assertUnits(units, label);
  if (units <= 0) throw new RangeError(`${label} must be positive, got ${units}`);
}

/** Display helper for logs/emails only. The API always returns raw units. */
export function formatTokens(units: number): string {
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  return `${sign}${Math.floor(abs / UNITS_PER_TOKEN).toLocaleString('en-US')}.${String(abs % UNITS_PER_TOKEN).padStart(2, '0')}`;
}

/** floor(a * b / c) using BigInt so large stakes × odds can never lose precision. */
export function mulDiv(a: number, b: number, c: number): number {
  assertUnits(a);
  assertUnits(b);
  assertUnits(c);
  if (c === 0) throw new RangeError('division by zero');
  const result = (BigInt(a) * BigInt(b)) / BigInt(c);
  const n = Number(result);
  assertUnits(n, 'mulDiv result');
  return n;
}
