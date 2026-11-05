/**
 * Search key for a registration plate, so staff can type it the way they speak it.
 * Moroccan plates look like "12345-أ-6" (number, Arabic letter, prefecture code); staff may type
 * "12345 أ 6", "12345|أ|6", "١٢٣٤٥-أ-٦" or "12345أ6".
 *
 * Deliberately conservative (owner examples still pending, BUSINESS_RULES open question 5):
 *  - separators and spaces are removed, Latin letters upper-cased;
 *  - Arabic-Indic digits become Latin digits; alef variants (أ إ آ ٱ) become ا; tatweel (ـ) is dropped;
 *  - Arabic letters are NOT transliterated to Latin letters (no unapproved mapping).
 * The plate as typed is always stored unchanged next to this key.
 */
export function plateKey(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)) // ٠-٩
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)) // ۰-۹
    .replace(/ـ/g, '') // tatweel, e.g. "هـ"
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .toUpperCase()
    .replace(/[^0-9A-Zء-ي]/g, '');
}
