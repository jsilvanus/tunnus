import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { loadUser } from '../accounts.js';
import { audit } from '../audit.js';
import { consume, getVerified, issueCode, verifyCode } from '../codes.js';
import { isValidEmail } from '../emailAddress.js';
import { pickLocale } from '../i18n.js';
import { decryptWithKey, deriveSubkey, encryptWithKey } from '../oidc/keys.js';
import { qrDataUrl } from '../qr.js';
import {
  base32Decode,
  buildOtpAuthUri,
  encryptTotpSecret,
  generateTotpSecret,
  verifyTotpToken,
} from '../totp.js';
import { sendInBackground } from './interactions.js';
import { accountCodePage, accountLoginPage, accountPage, accountTotpSetupPage } from './pages.js';

const FRESH_EMAIL_MS = 10 * 60 * 1000;
const ACCOUNT_SESSION_MS = 60 * 60 * 1000;
const COOKIE_SESSION = 'tunnus_account';
const COOKIE_CHALLENGE = 'tunnus_acct_chal';
const COOKIE_SETUP = 'tunnus_totp_setup';

/** @param {string} header */
function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {string} secret
 * @param {string} purpose
 * @param {unknown} value
 */
function seal(secret, purpose, value) {
  return encryptWithKey(JSON.stringify(value), deriveSubkey(secret, purpose));
}

/**
 * @param {string} secret
 * @param {string} purpose
 * @param {string | undefined} raw
 */
function unseal(secret, purpose, raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(decryptWithKey(raw, deriveSubkey(secret, purpose)));
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.exp !== 'number' ||
      data.exp <= Date.now()
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {string} secret
 * @param {string} sid
 */
function csrfToken(secret, sid) {
  return createHmac('sha256', deriveSubkey(secret, 'account-csrf')).update(sid).digest('hex');
}

/**
 * @param {string} secret
 * @param {string} sid
 * @param {unknown} sent
 */
function validCsrf(secret, sid, sent) {
  if (typeof sent !== 'string') return false;
  const expected = csrfToken(secret, sid);
  return (
    sent.length === expected.length && timingSafeEqual(Buffer.from(sent), Buffer.from(expected))
  );
}

/**
 * Self-service account pages (`<issuer>/account`) for viewing profile and managing TOTP.
 * @param {{
 *   config: import('../config.js').Config,
 *   pool: import('pg').Pool,
 *   getProvider: () => any,
 *   mailer: import('../mail.js').Mailer,
 * }} deps
 */
export function createAccountRouter({ config, pool, getProvider, mailer }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false });
  const cookiePath = `${config.basePath}/account`;
  const secure = config.issuer.startsWith('https:');

  router.use('/account', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** @param {any} req */
  const ctxOf = (req) => ({ config, locale: pickLocale(req, config.defaultLocale) });

  /**
   * @param {any} res
   * @param {string} name
   * @param {string} value
   * @param {number} maxAgeSec
   */
  const setCookie = (res, name, value, maxAgeSec) => {
    res.cookie(name, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: cookiePath,
      maxAge: maxAgeSec * 1000,
    });
  };

  /** @param {any} res @param {string} name */
  const clearCookie = (res, name) => {
    res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure, path: cookiePath });
  };

  /**
   * Resolve the signed-in user from the account cookie or an active OIDC provider session.
   * @param {any} req
   * @param {any} res
   */
  async function resolveAccount(req, res) {
    const cookies = parseCookies(String(req.headers.cookie ?? ''));
    const acct = unseal(config.keyEncryptionSecret, 'account-session', cookies[COOKIE_SESSION]);
    let userId = acct?.userId;
    let sid = acct?.sid;
    /** @type {any} */
    let oidcSession = null;

    try {
      const provider = getProvider();
      const oidcCtx = provider.createContext(req, res);
      const session = await provider.Session.get(oidcCtx);
      if (session?.accountId) {
        oidcSession = session;
        if (!userId) {
          userId = session.accountId;
          sid = session.uid || session.accountId;
        }
      }
    } catch {
      // Ignore missing/invalid OIDC session
    }
    if (!userId || !sid) return null;

    const user = await loadUser(pool, userId);
    if (!user || user.status !== 'active') return null;

    const { rows } = await pool.query(
      'SELECT totp_enabled_at, last_email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    const meta = rows[0];
    if (!meta) return null;

    const freshEmail = Boolean(
      meta.last_email_verified_at &&
      Date.now() - new Date(meta.last_email_verified_at).getTime() <= FRESH_EMAIL_MS,
    );

    return {
      user,
      sid: String(sid),
      oidcSession,
      totpEnabled: Boolean(meta.totp_enabled_at),
      freshEmail,
      csrf: csrfToken(config.keyEncryptionSecret, String(sid)),
      cookies,
    };
  }

  router.get('/account', async (req, res) => {
    const ctx = ctxOf(req);
    const acct = await resolveAccount(req, res);
    if (!acct) {
      return void res.send(accountLoginPage(ctx, `${config.basePath}/account/login`));
    }
    res.send(
      accountPage(ctx, {
        basePath: config.basePath,
        email: acct.user.email,
        displayName: acct.user.display_name || acct.user.email,
        groups: acct.user.groups,
        totpEnabled: acct.totpEnabled,
        freshEmail: acct.freshEmail,
        csrf: acct.csrf,
      }),
    );
  });

  router.post('/account/login', form, async (req, res) => {
    const ctx = ctxOf(req);
    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    if (!isValidEmail(email)) {
      return void res
        .status(400)
        .send(accountLoginPage(ctx, `${config.basePath}/account/login`, 'invalid_email'));
    }
    const uid = `acct_${randomBytes(16).toString('base64url')}`;
    const { rows } = await pool.query('SELECT id, status FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user && user.status === 'active') {
      const issued = await issueCode(pool, {
        secret: config.keyEncryptionSecret,
        limits: config.limits,
        email,
        uid,
        ip: req.ip ?? null,
        purpose: 'login',
      });
      if (issued.ok) {
        const link = `${config.issuer}/account`;
        sendInBackground(pool, {
          ip: req.ip ?? null,
          kind: 'sign_in_code',
          send: () => mailer.sendCode(email, issued.code, link, ctx.locale),
        });
      } else {
        await audit(pool, {
          action: 'rate_limited',
          ip: req.ip,
          details: { reason: issued.reason },
        });
      }
    }
    setCookie(
      res,
      COOKIE_CHALLENGE,
      seal(config.keyEncryptionSecret, 'account-challenge', {
        uid,
        email,
        exp: Date.now() + FRESH_EMAIL_MS,
      }),
      600,
    );
    res.send(accountCodePage(ctx, `${config.basePath}/account/login/code`));
  });

  router.post('/account/login/code', form, async (req, res) => {
    const ctx = ctxOf(req);
    const cookies = parseCookies(String(req.headers.cookie ?? ''));
    const chal = unseal(config.keyEncryptionSecret, 'account-challenge', cookies[COOKIE_CHALLENGE]);
    if (!chal) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const result = await verifyCode(
      pool,
      config.keyEncryptionSecret,
      chal.uid,
      String(req.body.code ?? ''),
    );
    if (!result.ok) {
      await audit(pool, { action: 'code_failed', ip: req.ip, details: { locked: result.locked } });
      return void res
        .status(400)
        .send(accountCodePage(ctx, `${config.basePath}/account/login/code`, 'invalid_code'));
    }
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND status = 'active'",
      [result.email],
    );
    const user = rows[0];
    if (!user) return void res.redirect(303, `${config.basePath}/account`);

    const verified = await getVerified(pool, chal.uid);
    if (verified) await consume(pool, verified.id);
    await pool.query(
      `UPDATE users
          SET last_email_verified_at = now(),
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [user.id],
    );
    clearCookie(res, COOKIE_CHALLENGE);
    const sid = randomBytes(16).toString('base64url');
    setCookie(
      res,
      COOKIE_SESSION,
      seal(config.keyEncryptionSecret, 'account-session', {
        userId: user.id,
        sid,
        exp: Date.now() + ACCOUNT_SESSION_MS,
      }),
      3600,
    );
    res.redirect(303, `${config.basePath}/account`);
  });

  router.post('/account/verify', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct || !validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const ctx = ctxOf(req);
    const uid = `acct_${randomBytes(16).toString('base64url')}`;
    const issued = await issueCode(pool, {
      secret: config.keyEncryptionSecret,
      limits: config.limits,
      email: acct.user.email,
      uid,
      ip: req.ip ?? null,
      purpose: 'login',
    });
    if (issued.ok) {
      sendInBackground(pool, {
        ip: req.ip ?? null,
        kind: 'sign_in_code',
        send: () =>
          mailer.sendCode(acct.user.email, issued.code, `${config.issuer}/account`, ctx.locale),
      });
    }
    setCookie(
      res,
      COOKIE_CHALLENGE,
      seal(config.keyEncryptionSecret, 'account-challenge', {
        uid,
        email: acct.user.email,
        exp: Date.now() + FRESH_EMAIL_MS,
      }),
      600,
    );
    res.send(accountCodePage(ctx, `${config.basePath}/account/verify/code`));
  });

  router.post('/account/verify/code', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    const chal = unseal(
      config.keyEncryptionSecret,
      'account-challenge',
      acct?.cookies[COOKIE_CHALLENGE],
    );
    if (!acct || !chal || chal.email !== acct.user.email) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const result = await verifyCode(
      pool,
      config.keyEncryptionSecret,
      chal.uid,
      String(req.body.code ?? ''),
    );
    if (!result.ok) {
      await audit(pool, {
        actorUserId: acct.user.id,
        action: 'code_failed',
        ip: req.ip,
        details: { locked: result.locked },
      });
      return void res
        .status(400)
        .send(
          accountCodePage(ctxOf(req), `${config.basePath}/account/verify/code`, 'invalid_code'),
        );
    }
    const verified = await getVerified(pool, chal.uid);
    if (verified) await consume(pool, verified.id);
    await pool.query(
      `UPDATE users
          SET last_email_verified_at = now(),
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [acct.user.id],
    );
    clearCookie(res, COOKIE_CHALLENGE);
    res.redirect(303, `${config.basePath}/account`);
  });

  router.post('/account/totp/start', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (
      !acct ||
      !acct.freshEmail ||
      !validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)
    ) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const { base32 } = generateTotpSecret();
    const issuer = config.brand.name || config.issuer;
    const uri = buildOtpAuthUri({ secretBase32: base32, email: acct.user.email, issuer });
    setCookie(
      res,
      COOKIE_SETUP,
      seal(config.keyEncryptionSecret, 'account-totp-setup', {
        userId: acct.user.id,
        secret: base32,
        exp: Date.now() + FRESH_EMAIL_MS,
      }),
      600,
    );
    res.send(
      accountTotpSetupPage(ctxOf(req), {
        action: `${config.basePath}/account/totp/confirm`,
        cancelHref: `${config.basePath}/account`,
        qrUrl: qrDataUrl(uri),
        secret: base32,
        csrf: acct.csrf,
      }),
    );
  });

  router.post('/account/totp/confirm', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (
      !acct ||
      !acct.freshEmail ||
      !validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)
    ) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const setup = unseal(
      config.keyEncryptionSecret,
      'account-totp-setup',
      acct.cookies[COOKIE_SETUP],
    );
    if (!setup || setup.userId !== acct.user.id || typeof setup.secret !== 'string') {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const check = verifyTotpToken(base32Decode(setup.secret), String(req.body.code ?? ''));
    if (!check.ok) {
      const issuer = config.brand.name || config.issuer;
      const uri = buildOtpAuthUri({
        secretBase32: setup.secret,
        email: acct.user.email,
        issuer,
      });
      return void res.status(400).send(
        accountTotpSetupPage(ctxOf(req), {
          action: `${config.basePath}/account/totp/confirm`,
          cancelHref: `${config.basePath}/account`,
          qrUrl: qrDataUrl(uri),
          secret: setup.secret,
          csrf: acct.csrf,
          error: 'invalid_code',
        }),
      );
    }
    const secretEnc = encryptTotpSecret(setup.secret, config.keyEncryptionSecret);
    await pool.query(
      `UPDATE users
          SET totp_secret_enc = $2,
              totp_enabled_at = now(),
              totp_last_step = $3,
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [acct.user.id, secretEnc, check.step],
    );
    await audit(pool, {
      actorUserId: acct.user.id,
      action: 'account_totp_enabled',
      targetType: 'user',
      targetId: acct.user.id,
      ip: req.ip,
    });
    clearCookie(res, COOKIE_SETUP);
    res.redirect(303, `${config.basePath}/account`);
  });

  router.post('/account/totp/disable', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (
      !acct ||
      !acct.freshEmail ||
      !validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)
    ) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    await pool.query(
      `UPDATE users
          SET totp_secret_enc = NULL,
              totp_enabled_at = NULL,
              totp_last_step = NULL,
              totp_failed_attempts = 0,
              totp_locked_until = NULL
        WHERE id = $1`,
      [acct.user.id],
    );
    await audit(pool, {
      actorUserId: acct.user.id,
      action: 'account_totp_disabled',
      targetType: 'user',
      targetId: acct.user.id,
      ip: req.ip,
    });
    res.redirect(303, `${config.basePath}/account`);
  });

  router.post('/account/logout', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (acct && !validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    if (acct?.oidcSession) {
      await pool.query(
        "DELETE FROM oidc_payloads WHERE type = 'Session' AND (uid = $1 OR id = $2)",
        [acct.oidcSession.uid ?? '', acct.oidcSession.jti ?? ''],
      );
      const oidcPath = config.basePath || '/';
      res.clearCookie('_session', { httpOnly: true, sameSite: 'lax', secure, path: oidcPath });
      res.clearCookie('_session.sig', { httpOnly: true, sameSite: 'lax', secure, path: oidcPath });
    }
    clearCookie(res, COOKIE_SESSION);
    clearCookie(res, COOKIE_CHALLENGE);
    clearCookie(res, COOKIE_SETUP);
    res.redirect(303, `${config.basePath}/account`);
  });

  return router;
}
