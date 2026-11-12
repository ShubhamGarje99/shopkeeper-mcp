/**
 * Shopify money arrives as decimal strings ("105.00"). Parse them with string
 * arithmetic only - floats never touch an amount. "Cents" in Shopify mode means
 * the currency's minor unit (JPY has 0 decimals, KWD has 3).
 */

const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** "105.00" (USD) -> 10500. Throws on malformed input or excess precision. */
export function decimalToMinor(amount: string, currency: string): number {
  const exp = currencyExponent(currency);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new TypeError(`Not a decimal money amount: ${JSON.stringify(amount)}`);
  const [, sign = "", whole = "0", frac = ""] = m;
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) {
    throw new TypeError(`Amount ${amount} has more precision than ${currency} allows`);
  }
  const padded = (frac + "0".repeat(exp)).slice(0, exp);
  const minor = Number(whole + padded);
  if (!Number.isSafeInteger(minor)) throw new TypeError(`Amount out of range: ${amount}`);
  return sign === "-" ? -minor : minor;
}

/** 10500 (USD) -> "105.00". */
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new TypeError(`minor units must be an integer, got ${minor}`);
  const exp = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = String(Math.abs(minor)).padStart(exp + 1, "0");
  if (exp === 0) return `${sign}${abs}`;
  return `${sign}${abs.slice(0, -exp)}.${abs.slice(-exp)}`;
}

/** "gid://shopify/Order/6012345678901" -> 6012345678901 */
export function gidToNumber(gid: string): number {
  const n = Number(gid.slice(gid.lastIndexOf("/") + 1));
  if (!Number.isSafeInteger(n)) throw new TypeError(`Unexpected Shopify id: ${gid}`);
  return n;
}
