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
 * Split a comma-separated list, trimming and dropping empty items.
 * @param {string | undefined} v
 * @returns {string[]}
 */
export function parseList(v) {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A Brevo template id from an env var: unset or empty gives undefined; otherwise a positive integer.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {number | undefined}
 */
function templateId(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(n))
    throw new Error(`${name} must be a positive integer`);
  return n;
}

/**
 * Brevo template ids per mail kind: BREVO_TEMPLATE_<KIND>_ID is the default and
 * BREVO_TEMPLATE_<KIND>_ID_FI / _SV / _EN override it for one locale. Read only when
 * MAIL_PROVIDER=brevo; for any other provider every id is undefined and nothing is checked.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} mailProvider
 */
export function loadBrevoTemplates(env, mailProvider) {
  /** @param {'SIGNIN' | 'INACTIVE'} kind */
  const read = (kind) => {
    const base = `BREVO_TEMPLATE_${kind}_ID`;
    if (mailProvider !== 'brevo')
      return { default: undefined, fi: undefined, sv: undefined, en: undefined };
    return {
      default: templateId(env, base),
      fi: templateId(env, `${base}_FI`),
      sv: templateId(env, `${base}_SV`),
      en: templateId(env, `${base}_EN`),
    };
  };
  return { signin: read('SIGNIN'), inactive: read('INACTIVE') };
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
 * @typedef {{ name: string, purpose: string, location: string }} Processor
 */

/**
 * Read the processors of the privacy notice from PROCESSORS (inline JSON) or
 * PROCESSORS_FILE (path to a JSON file). Setting both is an error.
 * @param {NodeJS.ProcessEnv} env
 * @param {(path: string, encoding: 'utf8') => string} readFile
 * @returns {Processor[]}
 */
export function parseProcessors(env, readFile) {
  const inline = (env.PROCESSORS ?? '').trim();
  const file = (env.PROCESSORS_FILE ?? '').trim();
  if (inline && file) throw new Error('Set PROCESSORS or PROCESSORS_FILE, not both');
  if (!inline && !file) return [];

  let text = inline;
  let source = 'PROCESSORS';
  if (file) {
    source = 'PROCESSORS_FILE';
    try {
      text = readFile(file, 'utf8');
    } catch {
      throw new Error('PROCESSORS_FILE could not be read');
    }
  }

  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${source} must be valid JSON`);
  }
  if (!Array.isArray(data)) throw new Error(`${source} must be a JSON array`);

  return data.map((/** @type {any} */ item, i) => {
    const fields = /** @type {const} */ (['name', 'purpose', 'location']);
    const ok =
      item !== null &&
      typeof item === 'object' &&
      fields.every((k) => typeof item[k] === 'string' && item[k].trim() !== '');
    if (!ok)
      throw new Error(`${source} item ${i} must have non-empty string name, purpose and location`);
    return { name: item.name.trim(), purpose: item.purpose.trim(), location: item.location.trim() };
  });
}

/** The placeholder value used in .env.example. Never a real secret. */
const PLACEHOLDER = 'change-me';

/**
 * TRUST_PROXY: 'true' and 'false' stay booleans, an all-digit value becomes a hop count
 * (Express treats a numeric string as an address list, so '1' would trust nothing), and any
 * other value is kept as an address list.
 * @param {string} raw
 * @returns {boolean | number | string}
 */
export function parseTrustProxy(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Reject secrets that are too short or still the example placeholder.
 * KEY_ENCRYPTION_SECRET must be 32+ characters; each COOKIE_SECRETS item 16+.
 * @param {NodeJS.ProcessEnv} env
 */
function validateSecrets(env) {
  const keySecret = /** @type {string} */ (env.KEY_ENCRYPTION_SECRET);
  if (keySecret === PLACEHOLDER)
    throw new Error('KEY_ENCRYPTION_SECRET must not be the example placeholder');
  if (keySecret.length < 32)
    throw new Error('KEY_ENCRYPTION_SECRET must be at least 32 characters');
  for (const item of parseList(env.COOKIE_SECRETS)) {
    if (item.startsWith(PLACEHOLDER))
      throw new Error('COOKIE_SECRETS must not contain the example placeholder');
    if (item.length < 16) throw new Error('COOKIE_SECRETS items must be at least 16 characters');
  }
}

/**
 * Load and validate the whole configuration from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ readFile?: (path: string, encoding: 'utf8') => string }} [io] injectable file reader
 */
export function loadConfig(env = process.env, io = {}) {
  const readFile =
    io.readFile ?? ((/** @type {string} */ p, /** @type {'utf8'} */ enc) => readFileSync(p, enc));
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
  // The console provider writes sign-in codes to the log. Refuse it on a public (https) issuer
  // unless the operator opts in, so a forgotten MAIL_PROVIDER is caught at start-up.
  if ((env.MAIL_PROVIDER ?? 'console') === 'console' && url.protocol === 'https:') {
    if (env.ALLOW_CONSOLE_MAIL !== 'true')
      throw new Error(
        'MAIL_PROVIDER must be smtp or brevo for an https ISSUER (console logs sign-in codes); ' +
          'set ALLOW_CONSOLE_MAIL=true only for a non-production test instance',
      );
  }
  if (env.MAIL_PROVIDER === 'smtp' && !env.SMTP_URL)
    throw new Error('SMTP_URL is required for smtp');
  if (env.MAIL_PROVIDER === 'brevo' && !env.BREVO_API_KEY)
    throw new Error('BREVO_API_KEY is required for brevo');
  if (!['fi', 'sv', 'en'].includes(env.DEFAULT_LOCALE ?? 'en'))
    throw new Error('DEFAULT_LOCALE must be fi, sv or en');

  validateSecrets(env);

  const intervalHours = int(env, 'CLEANUP_INTERVAL_HOURS', 24);
  if (intervalHours < 1) throw new Error('CLEANUP_INTERVAL_HOURS must be at least 1');

  const trustProxy = parseTrustProxy(env.TRUST_PROXY ?? 'false');
  return {
    issuer,
    basePath,
    databaseUrl: /** @type {string} */ (env.DATABASE_URL),
    port: int(env, 'PORT', 3000),
    keyEncryptionSecret: /** @type {string} */ (env.KEY_ENCRYPTION_SECRET),
    cookieSecrets: parseList(env.COOKIE_SECRETS),
    trustProxy,
    clientsFile: env.CLIENTS_FILE ?? '',
    signupAllow: env.SIGNUP_EMAIL_ALLOW ?? '',
    signupDeny: env.SIGNUP_EMAIL_DENY ?? '',
    defaultGroups: parseList(env.DEFAULT_GROUPS),
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 14),
    mailProvider: /** @type {'console' | 'smtp' | 'brevo'} */ (env.MAIL_PROVIDER ?? 'console'),
    mailFrom: env.MAIL_FROM ?? 'Tunnus <no-reply@localhost>',
    smtpUrl: env.SMTP_URL ?? '',
    brevoApiKey: env.BREVO_API_KEY ?? '',
    brevoTemplates: loadBrevoTemplates(env, env.MAIL_PROVIDER ?? 'console'),
    mailRelayToken: env.MAIL_RELAY_TOKEN ?? '',
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
    keyRetiredGraceDays: int(env, 'KEY_RETIRED_GRACE_DAYS', 7),
    keyReloadIntervalSeconds: int(env, 'KEY_RELOAD_INTERVAL_SECONDS', 60),
    adminValidateResponses: env.ADMIN_VALIDATE_RESPONSES === 'true',
    metricsBearerToken: env.METRICS_BEARER_TOKEN ?? '',
    privacy: {
      dpoContact: env.DPO_CONTACT ?? '',
      processors: parseProcessors(env, readFile),
    },
    cleanup: {
      disabled: env.CLEANUP_DISABLED === 'true',
      startDelaySeconds: int(env, 'CLEANUP_START_DELAY_SECONDS', 60),
      intervalHours,
    },
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
