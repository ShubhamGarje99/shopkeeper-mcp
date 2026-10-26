/**
 * Money is always integer cents internally. Floats never touch a stored amount;
 * formatting to dollars happens only at the presentation edge.
 */

export type Cents = number;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** 123456 -> "$1,234.56"; -995 -> "-$9.95" */
export function formatCents(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${rem}`;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return total;
}

/**
 * Split `amount` across `weights` proportionally using the largest-remainder
 * method, so the parts are integers that always sum exactly to `amount`.
 */
export function allocateProRata(amount: Cents, weights: readonly number[]): Cents[] {
  assertCents(amount);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (totalWeight <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / totalWeight);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = amount - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}
