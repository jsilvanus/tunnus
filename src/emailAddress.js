/** Characters that never belong in an address we send to or store: list separators, brackets, quotes, escapes. */
const FORBIDDEN = /[\s,;<>"()\\]/;

/**
 * Whether a string is an address we accept: at most 254 characters, exactly one `@`, no whitespace
 * or any of `, ; < > " ( ) \` in either part, and a domain made of non-empty labels with at least one
 * dot. The check is deliberately stricter than RFC 5322, which allows forms that mail systems
 * parse as address lists.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidEmail(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 254) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) return false;
  if (FORBIDDEN.test(local) || FORBIDDEN.test(domain)) return false;
  if (!domain.includes('.')) return false;
  return domain.split('.').every((label) => label.length > 0);
}
