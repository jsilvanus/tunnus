/**
 * Prefill a display name from an email address: "anna.virtanen@x" becomes
 * "Anna Virtanen". The user can edit it.
 * @param {string} email
 * @returns {string}
 */
export function displayNameFromEmail(email) {
  const local = email.split('@')[0].split('+')[0];
  const name = local
    .split(/[._]+/)
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/\d+/g, '')
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
        .join('-'),
    )
    .filter(Boolean)
    .join(' ');
  return name || local;
}
