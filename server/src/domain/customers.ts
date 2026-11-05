/**
 * Phone and identity-number keys used for search and duplicate warnings. The value as typed is
 * always stored unchanged next to its key.
 */

const toLatinDigits = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/**
 * International digits without "+" (wa.me format), e.g. "06 12 34 56 78" -> "212612345678",
 * "+33 6 12 34 56 78" / "0033612345678" -> "33612345678". A Moroccan national number (0 + 9
 * digits) gets the 212 prefix. Returns null when the number cannot be a phone number.
 */
export function phoneKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = toLatinDigits(input).trim();
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (/^0[5-8]\d{8}$/.test(digits)) {
    digits = `212${digits.slice(1)}`;
  } else if (/^[5-8]\d{8}$/.test(digits)) {
    digits = `212${digits}`;
  }
  return /^\d{6,20}$/.test(digits) ? digits : null;
}

/** Digit fragments to look for when staff search by (part of) a phone number. */
export function phoneSearchKeys(q: string): string[] {
  // "ZZ 1234" is a document number, not a phone number.
  if (/[A-Za-z\u0621-\u064A]/.test(q)) return [];
  const digits = toLatinDigits(q).replace(/\D/g, '');
  if (digits.length < 4) return [];
  const keys = new Set([digits]);
  if (digits.startsWith('00')) keys.add(digits.slice(2));
  else if (digits.startsWith('0')) keys.add(`212${digits.slice(1)}`);
  return [...keys];
}

/** Identity document / licence number key: Latin letters upper-cased, digits, nothing else. */
export function docNumberKey(input: string | null | undefined): string | null {
  if (!input) return null;
  const key = toLatinDigits(input).toUpperCase().replace(/[^0-9A-Z]/g, '');
  return key.length >= 2 ? key.slice(0, 40) : null;
}
