import { readFileSync } from 'node:fs';

/**
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
 * @param {string | undefined} v
 * @returns {string[]}
 */
function list(v) {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Retention-related settings.
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

/**
 * Load and validate the whole configuration from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const missing = ['ISSUER', 'DATABASE_URL', 'KEY_ENCRYPTION_SECRET', 'COOKIE_SECRETS'].filter(
    (k) => !env[k],
  );
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')}`);

  const issuer = /** @type {string} */ (env.ISSUER);
  const url = new URL(issuer);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ISSUER must be http(s)');
  if (issuer.endsWith('/')) throw new Error('ISSUER must not end with a slash');
  const basePath = url.pathname === '/' ? '' : url.pathname;

  if (!['console', 'smtp', 'brevo'].includes(env.MAIL_PROVIDER ?? 'console'))
    throw new Error('MAIL_PROVIDER must be console, smtp or brevo');
  if (env.MAIL_PROVIDER === 'smtp' && !env.SMTP_URL)
    throw new Error('SMTP_URL is required for smtp');
  if (env.MAIL_PROVIDER === 'brevo' && !env.BREVO_API_KEY)
    throw new Error('BREVO_API_KEY is required for brevo');
  if (!['fi', 'sv', 'en'].includes(env.DEFAULT_LOCALE ?? 'en'))
    throw new Error('DEFAULT_LOCALE must be fi, sv or en');

  const trustProxy = env.TRUST_PROXY ?? 'false';
  return {
    issuer,
    basePath,
    databaseUrl: /** @type {string} */ (env.DATABASE_URL),
    port: int(env, 'PORT', 3000),
    keyEncryptionSecret: /** @type {string} */ (env.KEY_ENCRYPTION_SECRET),
    cookieSecrets: list(env.COOKIE_SECRETS),
    trustProxy: trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy,
    clientsFile: env.CLIENTS_FILE ?? '',
    signupAllow: env.SIGNUP_EMAIL_ALLOW ?? '',
    signupDeny: env.SIGNUP_EMAIL_DENY ?? '',
    defaultGroups: list(env.DEFAULT_GROUPS),
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 14),
    mailProvider: /** @type {'console' | 'smtp' | 'brevo'} */ (env.MAIL_PROVIDER ?? 'console'),
    mailFrom: env.MAIL_FROM ?? 'Tunnus <no-reply@localhost>',
    smtpUrl: env.SMTP_URL ?? '',
    brevoApiKey: env.BREVO_API_KEY ?? '',
    limits: {
      perEmailPerHour: int(env, 'RATE_LIMIT_EMAIL_PER_HOUR', 5),
      perIpPerHour: int(env, 'RATE_LIMIT_IP_PER_HOUR', 20),
      mailPerDay: int(env, 'MAIL_DAILY_CAP', 500),
    },
    controller: {
      name: env.CONTROLLER_NAME ?? '',
      contact: env.CONTROLLER_CONTACT ?? '',
    },
    brand: {
      name: env.BRAND_NAME ?? 'Tunnus',
      logoUrl: env.BRAND_LOGO_URL ?? '',
      color: env.BRAND_COLOR ?? '#1f4e79',
      privacyNoticeUrl: env.PRIVACY_NOTICE_URL ?? '',
    },
    defaultLocale: /** @type {'fi' | 'sv' | 'en'} */ (env.DEFAULT_LOCALE ?? 'en'),
    retention: loadRetentionConfig(env),
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

/**
 * Load clients from a JSON file. String values of the form `${NAME}` are
 * replaced with the environment variable NAME.
 * @param {string} file
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>[]}
 */
export function loadClients(file, env = process.env) {
  if (!file) return [];
  const clients = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(clients)) throw new Error('CLIENTS_FILE must contain a JSON array');
  return clients.map((c) =>
    Object.fromEntries(
      Object.entries(c).map(([k, v]) => [
        k,
        typeof v === 'string'
          ? v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => {
              if (env[n] === undefined) throw new Error(`Client file references unset ${n}`);
              return env[n];
            })
          : v,
      ]),
    ),
  );
}
