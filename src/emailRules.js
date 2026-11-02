/**
 * Compile a wildcard pattern (`*` matches any characters) into a RegExp
 * matched against the whole, lowercased address.
 * @param {string} pattern
 * @returns {RegExp}
 */
function compile(pattern) {
  const escaped = pattern
    .trim()
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Parse a comma-separated pattern list.
 * @param {string | undefined} list
 * @returns {RegExp[]}
 */
export function parsePatterns(list) {
  return (list ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(compile);
}

/**
 * Build a sign-up check from allow and deny pattern lists. Deny wins; an
 * empty allow list closes sign-up.
 * @param {{ allow?: string, deny?: string }} rules
 * @returns {(email: string) => boolean}
 */
export function createSignupRule({ allow, deny }) {
  const allowed = parsePatterns(allow);
  const denied = parsePatterns(deny);
  return (email) => {
    const e = email.trim().toLowerCase();
    if (denied.some((r) => r.test(e))) return false;
    return allowed.some((r) => r.test(e));
  };
}
