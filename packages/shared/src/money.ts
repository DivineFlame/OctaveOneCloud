/**
 * Money is always stored and computed as integer minor units (paise for INR).
 * Conversion to decimal strings happens only at provider boundaries.
 */
export const SUPPORTED_CURRENCIES = ['INR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const MINOR_DIGITS: Record<Currency, number> = { INR: 2 };

export class MoneyError extends Error {}

export function assertMinor(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of minor units, got ${value}`);
  }
  return value;
}

export function assertNonNegativeMinor(value: number, label = 'amount'): number {
  assertMinor(value, label);
  if (value < 0) throw new MoneyError(`${label} must not be negative`);
  return value;
}

/** Converts minor units to an exact decimal string, e.g. 123456 -> "1234.56". */
export function minorToDecimalString(minor: number, currency: Currency = 'INR'): string {
  assertMinor(minor);
  const digits = MINOR_DIGITS[currency];
  const negative = minor < 0;
  const abs = Math.abs(minor).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const frac = abs.slice(abs.length - digits);
  return `${negative ? '-' : ''}${whole}${digits ? '.' + frac : ''}`;
}

/**
 * Parses a provider decimal amount ("1234.5", 1234.5, "1234.50") into minor units exactly.
 * Rejects values with more fractional digits than the currency allows instead of rounding.
 */
export function decimalToMinor(value: string | number, currency: Currency = 'INR'): number {
  const digits = MINOR_DIGITS[currency];
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError(`Invalid decimal amount: ${String(value)}`);
  const [, sign, whole, fracRaw = ''] = match;
  const frac = fracRaw.replace(/0+$/, '');
  if (frac.length > digits) {
    throw new MoneyError(`Amount ${text} has more than ${digits} fractional digits`);
  }
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  return assertMinor(sign ? -minor : minor);
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new MoneyError('Amount must be finite');
  // toFixed(6) avoids exponent notation; trailing zeros are stripped by the parser.
  return value.toFixed(6);
}

/** Multiplies minor units by basis points (1/100 of a percent) with half-up rounding. */
export function applyBasisPoints(minor: number, bps: number): number {
  assertMinor(minor);
  assertMinor(bps, 'basis points');
  return divideRoundHalfUp(minor * bps, 10_000);
}

/** Integer division rounding half away from zero. */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  assertMinor(numerator, 'numerator');
  assertMinor(denominator, 'denominator');
  if (denominator === 0) throw new MoneyError('Division by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (r * 2 >= d ? q + 1 : q);
}

export function divideCeil(numerator: number, denominator: number): number {
  assertNonNegativeMinor(numerator, 'numerator');
  if (denominator <= 0 || !Number.isSafeInteger(denominator)) throw new MoneyError('Invalid denominator');
  return Math.ceil(numerator / denominator);
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce((acc, v) => assertMinor(acc + assertMinor(v)), 0);
}

export function formatMoney(minor: number, currency: Currency = 'INR', locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    Number(minorToDecimalString(minor, currency)),
  );
}
