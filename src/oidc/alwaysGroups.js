/**
 * The client ids flagged `always_include_groups`.
 * @param {Record<string, any>[]} clients
 */
export function alwaysGroupsOf(clients) {
  return new Set(clients.filter((c) => c.always_include_groups).map((c) => c.client_id));
}

/**
 * The scope with `groups` added for a flagged client, or undefined when nothing changes.
 * @param {unknown} scope
 * @param {unknown} clientId
 * @param {Set<string>} alwaysGroups
 * @returns {string | undefined}
 */
export function scopeWithGroups(scope, clientId, alwaysGroups) {
  if (typeof scope !== 'string' || typeof clientId !== 'string') return undefined;
  if (!alwaysGroups.has(clientId)) return undefined;
  if (scope.split(' ').includes('groups')) return undefined;
  return `${scope} groups`;
}
