import { describe, expect, it } from 'vitest';
import { applyBasisPoints, decimalToMinor, divideRoundHalfUp, minorToDecimalString, MoneyError } from '../src/money';

describe('money', () => {
  it('round-trips decimal strings exactly', () => {
    expect(minorToDecimalString(123456)).toBe('1234.56');
    expect(minorToDecimalString(5)).toBe('0.05');
    expect(minorToDecimalString(-150)).toBe('-1.50');
    expect(decimalToMinor('1234.56')).toBe(123456);
    expect(decimalToMinor('1234.5')).toBe(123450);
    expect(decimalToMinor(0.1 + 0.2 === 0.3 ? '0.3' : '0.30')).toBe(30);
    expect(decimalToMinor(19.99)).toBe(1999);
  });
  it('rejects sub-paise precision instead of rounding', () => {
    expect(() => decimalToMinor('1.005')).toThrow(MoneyError);
    expect(() => decimalToMinor('abc')).toThrow(MoneyError);
  });
  it('rounds half away from zero', () => {
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(-5, 2)).toBe(-3);
    expect(applyBasisPoints(1000, 1800)).toBe(180);
    expect(applyBasisPoints(999, 900)).toBe(90); // 89.91 -> 90
  });
  it('rejects non-integer minor units', () => {
    expect(() => applyBasisPoints(10.5, 100)).toThrow(MoneyError);
  });
});
