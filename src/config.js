/**
 * Read a boolean-ish integer setting from the environment.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function int(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/**
 * Load retention-related settings (the rest of the config arrives in phase 1).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadRetentionConfig(env = process.env) {
  return {
    inactiveUserDeleteDays: int(env, 'INACTIVE_USER_DELETE_DAYS', 730),
    inactiveUserWarnDays: int(env, 'INACTIVE_USER_WARN_DAYS', 30),
    auditRetentionDays: int(env, 'AUDIT_RETENTION_DAYS', 365),
    auditIpRetentionDays: int(env, 'AUDIT_IP_RETENTION_DAYS', 30),
  };
}
