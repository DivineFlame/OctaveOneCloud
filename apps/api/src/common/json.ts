/** Serialises BigInt values (minor units) as JS numbers after a safe-range check. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') {
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('BigInt out of range');
        return Number(v);
      }
      return v;
    }),
  );
}
