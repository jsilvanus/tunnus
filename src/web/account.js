import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { isAccountActive, loadUser } from '../accounts.js';
import { audit } from '../audit.js';
import { consume, getVerified, issueCode, verifyCode } from '../codes.js';
import { isValidEmail } from '../emailAddress.js';
import { pickLocale, t } from '../i18n.js';
import { decryptWithKey, deriveSubkey, encryptWithKey } from '../oidc/keys.js';
import { qrDataUrl } from '../qr.js';
import {
  base32Decode,
  buildOtpAuthUri,
  encryptTotpSecret,
  generateTotpSecret,
  isTotpEligible,
  verifyTotpToken,
  verifyUserTotp,
} from '../totp.js';
import { sendInBackground } from './interactions.js';
import { accountCodePage, accountLoginPage, accountPage, accountTotpSetupPage } from './pages.js';
import {
  clearDbMcpCommitList,
  executeDbMcpCommitList,
  getDbMcpState,
  setDbMcpFixedTime,
  setDbMcpLock,
} from '../mcp/dbState.js';
import { getFixedTimeRemainingMs, isFixedTimeRunning } from '../client/mcpState.js';
import { dispatchBackchannelLogout } from '../oidc/backchannel.js';
import { errorFields, logger } from '../logger.js';

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
 *   callAdminApi?: (op: any, args: any, user: any) => Promise<any>,
 *   opsById?: Map<string, any>,
 * }} deps
 */
export function createAccountRouter({ config, pool, getProvider, mailer, callAdminApi, opsById }) {
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
    if (!user) return null;

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
    let mcp = null;
    if (acct.user.groups.includes('admin')) {
      const state = await getDbMcpState(pool, acct.user.id);
      mcp = {
        fixedTimeRunning: isFixedTimeRunning(state),
        remainingMinutes: Math.ceil(getFixedTimeRemainingMs(state) / 60000),
        listLocked: Boolean(state.listLocked),
        commitList: state.commitList,
        notice: typeof req.query.mcp_notice === 'string' ? req.query.mcp_notice : undefined,
        error: typeof req.query.mcp_error === 'string' ? req.query.mcp_error : undefined,
      };
    }

    const { rows: grantRows } = await pool.query(
      `SELECT id, payload, expires_at
         FROM oidc_payloads
        WHERE type = 'Grant'
          AND payload->>'accountId' = $1
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (payload->>'iat')::bigint DESC NULLS LAST, id DESC`,
      [acct.user.id],
    );

    const appsMap = new Map();
    const provider = getProvider ? getProvider() : null;
    for (const row of grantRows) {
      const clientId = row.payload?.clientId;
      if (!clientId) continue;
      if (!appsMap.has(clientId)) {
        appsMap.set(clientId, {
          clientId,
          clientName: clientId,
          scopes: new Set(),
          resources: new Set(),
        });
      }
      const item = appsMap.get(clientId);
      if (row.payload.openid?.scope) {
        for (const s of String(row.payload.openid.scope).split(' ')) {
          if (s) item.scopes.add(s);
        }
      }
      if (row.payload.resources) {
        if (Array.isArray(row.payload.resources)) {
          for (const r of row.payload.resources) {
            if (typeof r === 'string' && r) item.resources.add(r);
            else if (r && typeof r === 'object' && r.indicator) item.resources.add(r.indicator);
          }
        } else if (typeof row.payload.resources === 'object') {
          for (const r of Object.keys(row.payload.resources)) {
            if (r) item.resources.add(r);
          }
        }
      }
    }

    /** @type {Array<{ clientId: string, clientName: string, scopes: string[], resources?: string[], isMcp: boolean }>} */
    const apps = [];
    for (const [clientId, item] of appsMap) {
      let isFirstParty = false;
      if (provider?.Client) {
        try {
          const client = await provider.Client.find(clientId);
          if (client) {
            item.clientName = client.clientName || client.client_name || clientId;
            isFirstParty = Boolean(client.first_party);
          }
        } catch {
          // ignore
        }
      }
      const hasMcp = item.scopes.has('mcp');
      // Show external/third-party apps (e.g. ChatGPT, MCP clients); omit internal SSO first-party apps (e.g. Vuorot)
      if (hasMcp || !isFirstParty) {
        apps.push({
          clientId: item.clientId,
          clientName: item.clientName,
          scopes: Array.from(item.scopes),
          resources: Array.from(item.resources || []),
          isMcp: hasMcp,
        });
      }
    }

    res.send(
      accountPage(ctx, {
        basePath: config.basePath,
        email: acct.user.email,
        displayName: acct.user.display_name || acct.user.email,
        title: acct.user.title || null,
        phoneNumber: acct.user.phone_number || null,
        status: acct.user.status,
        isActive: isAccountActive(acct.user),
        activatesAt: acct.user.activates_at || null,
        disablesAt: acct.user.disables_at || null,
        groups: acct.user.groups,
        totpEnabled: acct.totpEnabled,
        freshEmail: acct.freshEmail,
        csrf: acct.csrf,
        apps,
        appNotice: typeof req.query.app_notice === 'string' ? req.query.app_notice : undefined,
        mcp,
      }),
    );
  });

  router.post('/account/apps/revoke', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct) return void res.redirect(302, `${config.basePath}/account`);
    if (!validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.status(403).send('Invalid CSRF token');
    }
    const clientId = String(req.body.clientId ?? '').trim();
    if (!clientId) {
      return void res.redirect(302, `${config.basePath}/account`);
    }

    let clientName = clientId;
    try {
      const provider = getProvider ? getProvider() : null;
      if (provider?.Client) {
        const client = await provider.Client.find(clientId);
        if (client) {
          clientName = client.clientName || client.client_name || clientId;
        }
      }
    } catch {
      // ignore
    }

    await pool.query(
      `DELETE FROM oidc_payloads
        WHERE (type = 'Grant' AND payload->>'accountId' = $1 AND payload->>'clientId' = $2)
           OR grant_id IN (
                SELECT id FROM oidc_payloads
                 WHERE type = 'Grant' AND payload->>'accountId' = $1 AND payload->>'clientId' = $2
              )`,
      [acct.user.id, clientId],
    );

    await audit(pool, {
      actorUserId: acct.user.id,
      action: 'account_app_revoked',
      targetType: 'client',
      targetId: clientId,
      ip: req.ip ?? null,
    });

    void dispatchBackchannelLogout({
      config,
      pool,
      getProvider,
      userId: acct.user.id,
      clientId,
      events: {
        'http://schemas.openid.net/event/backchannel-logout': {},
        'https://tunnus.fi/event/mcp-revoke': { clientId },
      },
    }).catch((err) => {
      logger.warn({ err: errorFields(err), clientId }, 'dispatchBackchannelLogout failed');
    });

    const ctx = ctxOf(req);
    const notice = t(ctx.locale, 'account_apps_revoked_notice', { client: clientName });
    res.redirect(302, `${config.basePath}/account?app_notice=${encodeURIComponent(notice)}`);
  });

  router.post('/account/mcp/lease', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct) return void res.redirect(302, `${config.basePath}/account`);
    if (!validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.status(403).send('Invalid CSRF token');
    }
    if (!acct.user.groups.includes('admin')) {
      return void res.status(403).send('Forbidden: admin only');
    }
    const action = String(req.body.action ?? '');
    if (action === 'enable') {
      await setDbMcpFixedTime(pool, { minutes: 15, userId: acct.user.id });
      await audit(pool, {
        action: 'mcp.lease_enabled',
        actorUserId: acct.user.id,
        ip: req.ip ?? null,
        details: { minutes: 15 },
      });
      return void res.redirect(
        302,
        `${config.basePath}/account?mcp_notice=15-minute lease enabled`,
      );
    }
    if (action === 'cancel') {
      await setDbMcpFixedTime(pool, { minutes: 0, userId: acct.user.id });
      await audit(pool, {
        action: 'mcp.lease_cancelled',
        actorUserId: acct.user.id,
        ip: req.ip ?? null,
      });
      return void res.redirect(302, `${config.basePath}/account?mcp_notice=Lease cancelled`);
    }
    res.redirect(302, `${config.basePath}/account`);
  });

  router.post('/account/mcp/lock', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct) return void res.redirect(302, `${config.basePath}/account`);
    if (!validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.status(403).send('Invalid CSRF token');
    }
    if (!acct.user.groups.includes('admin')) {
      return void res.status(403).send('Forbidden: admin only');
    }
    const locked = req.body.locked === 'true';
    await setDbMcpLock(pool, { locked, userId: acct.user.id });
    await audit(pool, {
      action: locked ? 'mcp.list_locked' : 'mcp.list_unlocked',
      actorUserId: acct.user.id,
      ip: req.ip ?? null,
    });
    res.redirect(302, `${config.basePath}/account`);
  });

  router.post('/account/mcp/clear', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct) return void res.redirect(302, `${config.basePath}/account`);
    if (!validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.status(403).send('Invalid CSRF token');
    }
    if (!acct.user.groups.includes('admin')) {
      return void res.status(403).send('Forbidden: admin only');
    }
    await clearDbMcpCommitList(pool, { userId: acct.user.id });
    await audit(pool, {
      action: 'mcp.list_cleared',
      actorUserId: acct.user.id,
      ip: req.ip ?? null,
    });
    res.redirect(302, `${config.basePath}/account?mcp_notice=Commit list cleared`);
  });

  router.post('/account/mcp/commit', form, async (req, res) => {
    const acct = await resolveAccount(req, res);
    if (!acct) return void res.redirect(302, `${config.basePath}/account`);
    if (!validCsrf(config.keyEncryptionSecret, acct.sid, req.body.csrf)) {
      return void res.status(403).send('Invalid CSRF token');
    }
    if (!acct.user.groups.includes('admin')) {
      return void res.status(403).send('Forbidden: admin only');
    }
    const state = await getDbMcpState(pool, acct.user.id);
    if (!state.listLocked) {
      return void res.redirect(
        302,
        `${config.basePath}/account?mcp_error=Commit list must be locked before execution`,
      );
    }
    if (!callAdminApi || !opsById) {
      return void res.redirect(
        302,
        `${config.basePath}/account?mcp_error=Admin API execution not available`,
      );
    }
    const result = await executeDbMcpCommitList(pool, {
      callApi: (op, args) => callAdminApi(op, args, acct.user),
      opsById,
      userId: acct.user.id,
      ip: req.ip ?? null,
    });
    if (!result.ok) {
      return void res.redirect(
        302,
        `${config.basePath}/account?mcp_error=${encodeURIComponent(result.error)}`,
      );
    }
    res.redirect(
      302,
      `${config.basePath}/account?mcp_notice=${encodeURIComponent(
        `Successfully executed ${result.executed.length} action(s).`,
      )}`,
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
    const { rows } = await pool.query(
      `SELECT id, status, totp_secret_enc, totp_enabled_at, totp_locked_until, last_email_verified_at
         FROM users
        WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    const allowed = Boolean(user);
    const totpReady =
      allowed &&
      isTotpEligible(user, {
        reverifyDays: config.totpEmailReverifyDays,
        allowInactive: true,
      });

    if (allowed && !totpReady) {
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
    res.send(
      accountCodePage(ctx, `${config.basePath}/account/login/code`, undefined, {
        resendAction: `${config.basePath}/account/login/resend`,
      }),
    );
  });

  router.post('/account/login/resend', form, async (req, res) => {
    const ctx = ctxOf(req);
    const cookies = parseCookies(String(req.headers.cookie ?? ''));
    const chal = unseal(config.keyEncryptionSecret, 'account-challenge', cookies[COOKIE_CHALLENGE]);
    if (!chal) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const { rows } = await pool.query('SELECT id, status FROM users WHERE email = $1', [
      chal.email,
    ]);
    const user = rows[0];
    if (user) {
      const issued = await issueCode(pool, {
        secret: config.keyEncryptionSecret,
        limits: config.limits,
        email: chal.email,
        uid: chal.uid,
        ip: req.ip ?? null,
        purpose: 'login',
      });
      if (issued.ok) {
        const link = `${config.issuer}/account`;
        sendInBackground(pool, {
          ip: req.ip ?? null,
          kind: 'sign_in_code',
          send: () => mailer.sendCode(chal.email, issued.code, link, ctx.locale),
        });
      } else {
        await audit(pool, {
          action: 'rate_limited',
          ip: req.ip,
          details: { reason: issued.reason },
        });
      }
    }
    res.send(
      accountCodePage(ctx, `${config.basePath}/account/login/code`, undefined, {
        resendAction: `${config.basePath}/account/login/resend`,
        messageKey: 'code_sent',
      }),
    );
  });

  router.post('/account/login/code', form, async (req, res) => {
    const ctx = ctxOf(req);
    const cookies = parseCookies(String(req.headers.cookie ?? ''));
    const chal = unseal(config.keyEncryptionSecret, 'account-challenge', cookies[COOKIE_CHALLENGE]);
    if (!chal) {
      return void res.redirect(303, `${config.basePath}/account`);
    }
    const code = String(req.body.code ?? '');
    const result = await verifyCode(pool, config.keyEncryptionSecret, chal.uid, code);
    if (result.ok) {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
        result.email,
      ]);
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
      await audit(pool, {
        actorUserId: user.id,
        action: 'account_login',
        targetType: 'user',
        targetId: user.id,
        ip: req.ip,
      });
      return void res.redirect(303, `${config.basePath}/account`);
    }

    if (chal.email) {
      const totp = await verifyUserTotp(pool, {
        secret: config.keyEncryptionSecret,
        email: chal.email,
        code,
        reverifyDays: config.totpEmailReverifyDays,
        allowInactive: true,
      });
      if (totp.ok) {
        await pool.query(
          'UPDATE email_codes SET consumed_at = now() WHERE interaction_uid = $1 AND consumed_at IS NULL',
          [chal.uid],
        );
        clearCookie(res, COOKIE_CHALLENGE);
        const sid = randomBytes(16).toString('base64url');
        setCookie(
          res,
          COOKIE_SESSION,
          seal(config.keyEncryptionSecret, 'account-session', {
            userId: totp.userId,
            sid,
            exp: Date.now() + ACCOUNT_SESSION_MS,
          }),
          3600,
        );
        await audit(pool, {
          actorUserId: totp.userId,
          action: 'account_login_totp',
          targetType: 'user',
          targetId: totp.userId,
          ip: req.ip,
        });
        return void res.redirect(303, `${config.basePath}/account`);
      }
      if (totp.reason !== 'not_eligible') {
        await audit(pool, {
          actorUserId: totp.userId,
          action: totp.locked ? 'totp_locked' : 'totp_failed',
          targetType: 'user',
          targetId: totp.userId,
          ip: req.ip,
          details: { reason: totp.reason },
        });
        return void res.status(400).send(
          accountCodePage(ctx, `${config.basePath}/account/login/code`, 'invalid_code', {
            resendAction: `${config.basePath}/account/login/resend`,
          }),
        );
      }
    }

    await audit(pool, { action: 'code_failed', ip: req.ip, details: { locked: result.locked } });
    return void res.status(400).send(
      accountCodePage(ctx, `${config.basePath}/account/login/code`, 'invalid_code', {
        resendAction: `${config.basePath}/account/login/resend`,
      }),
    );
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
