import express from 'express';
import { audit } from '../audit.js';
import { createUser, findUserByEmail, loadUser } from '../accounts.js';
import { consume, getVerified, issueCode, verifyCode, verifyLink } from '../codes.js';
import { displayNameFromEmail } from '../displayName.js';
import { isValidEmail } from '../emailAddress.js';
import { createSignupRule } from '../emailRules.js';
import { pickLocale } from '../i18n.js';
import {
  codePage,
  consentPage,
  continuePage,
  emailPage,
  linkCodePage,
  linkConfirmPage,
  linkInvalidPage,
  logoutDonePage,
  namePage,
} from './pages.js';

/**
 * Send a mail without waiting for it. A failure is audited with the error name only: provider
 * error text can contain the recipient address, and audit details must not hold one.
 * @param {import('pg').Pool} pool
 * @param {{ ip: string | null, kind: string, send: () => Promise<void> }} p
 */
export function sendInBackground(pool, { ip, kind, send }) {
  void (async () => {
    try {
      await send();
    } catch (err) {
      const name = /** @type {any} */ (err)?.name;
      const error = typeof name === 'string' ? name : 'Error';
      await audit(pool, { action: 'mail_error', ip, details: { kind, error } }).catch(() => {});
    }
  })();
}

/**
 * End-user interaction pages: email, code, link, name, account choice and consent.
 * @param {{ config: import('../config.js').Config, pool: import('pg').Pool, getProvider: () => any, mailer: import('../mail.js').Mailer }} deps
 */
export function createInteractionRouter({ config, pool, getProvider, mailer }) {
  const router = express.Router();
  const canSignUp = createSignupRule({ allow: config.signupAllow, deny: config.signupDeny });
  const form = express.urlencoded({ extended: false });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  /** @param {any} req */
  const ctxOf = (req) => ({ config, locale: pickLocale(req, config.defaultLocale) });
  /** @param {string} uid */
  const base = (uid) => `${config.basePath}/interaction/${uid}`;
  /**
   * @param {any} req
   * @param {any} res
   */
  const details = async (req, res) => {
    try {
      return await getProvider().interactionDetails(req, res);
    } catch {
      return undefined;
    }
  };
  /**
   * @param {any} res
   * @param {any} req
   */
  const expired = (req, res) => res.status(400).send(linkInvalidPage(ctxOf(req)));

  /**
   * Finish the login step for an existing user.
   * @param {any} req
   * @param {any} res
   * @param {string} userId
   */
  async function finishLogin(req, res, userId, action = 'signin') {
    await pool.query(
      'UPDATE users SET last_login_at = now(), inactive_warned_at = NULL WHERE id = $1',
      [userId],
    );
    await audit(pool, {
      actorUserId: userId,
      action,
      targetType: 'user',
      targetId: userId,
      ip: req.ip,
    });
    await getProvider().interactionFinished(
      req,
      res,
      { login: { accountId: userId } },
      { mergeWithLastSubmission: false },
    );
  }

  /**
   * A code or link was accepted: sign in, or ask new users for a display name.
   * @param {any} req
   * @param {any} res
   * @param {string} uid
   * @param {string} email
   */
  async function afterVerified(req, res, uid, email) {
    const user = await findUserByEmail(pool, email);
    if (user && user.status === 'active') {
      const verified = await getVerified(pool, uid);
      if (verified) await consume(pool, verified.id);
      return finishLogin(req, res, user.id);
    }
    if (user || !canSignUp(email)) return expired(req, res);
    res.redirect(303, `${base(uid)}/name`);
  }

  router.get('/interaction/:uid', async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    const ctx = ctxOf(req);
    if (d.prompt.name === 'login') {
      const forceLogin = String(d.params.prompt ?? '')
        .split(' ')
        .includes('login');
      if (d.session?.accountId && !forceLogin) {
        const user = await loadUser(pool, d.session.accountId);
        if (user && user.status === 'active') {
          return void res.send(
            continuePage(ctx, {
              continueAction: `${base(d.uid)}/continue`,
              otherAction: `${base(d.uid)}/other`,
              logoutAction: `${base(d.uid)}/logout`,
              name: user.display_name || user.email,
              email: user.email,
            }),
          );
        }
      }
      return void res.send(emailPage(ctx, `${base(d.uid)}/email`));
    }
    const client = await getProvider().Client.find(d.params.client_id);
    const scopes = String(d.params.scope ?? '')
      .split(' ')
      .filter(Boolean);
    res.send(
      consentPage(ctx, `${base(d.uid)}/confirm`, client?.clientName ?? d.params.client_id, scopes),
    );
  });

  router.post('/interaction/:uid/continue', form, async (req, res) => {
    const d = await details(req, res);
    if (!d?.session?.accountId) return expired(req, res);
    // Disabling a user ends its sessions, but a session that outlived the change must not sign in.
    const user = await loadUser(pool, d.session.accountId);
    if (!user || user.status !== 'active') return expired(req, res);
    await finishLogin(req, res, user.id, 'signin_continue');
  });

  /**
   * Remove the active browser session from storage and detach it from the current interaction.
   * @param {any} d
   */
  async function clearBrowserSession(d) {
    const sessionUid = d?.session?.uid;
    const sessionCookie = d?.session?.cookie;
    if (sessionUid || sessionCookie) {
      await pool.query(
        "DELETE FROM oidc_payloads WHERE type = 'Session' AND (uid = $1 OR id = $2)",
        [sessionUid ?? '', sessionCookie ?? ''],
      );
    }
    if (d?.uid) {
      await pool.query(
        "UPDATE oidc_payloads SET payload = payload - 'session' WHERE type = 'Interaction' AND (id = $1 OR uid = $1)",
        [d.uid],
      );
    }
  }

  router.post('/interaction/:uid/other', form, async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    await clearBrowserSession(d);
    res.send(emailPage(ctxOf(req), `${base(d.uid)}/email`));
  });

  router.post('/interaction/:uid/logout', form, async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    await clearBrowserSession(d);
    await pool.query(
      "DELETE FROM oidc_payloads WHERE type = 'Interaction' AND (id = $1 OR uid = $1)",
      [d.uid],
    );
    res.send(logoutDonePage(ctxOf(req)));
  });

  router.post('/interaction/:uid/email', form, async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    const ctx = ctxOf(req);
    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    if (!isValidEmail(email))
      return void res.send(emailPage(ctx, `${base(d.uid)}/email`, 'invalid_email'));

    const user = await findUserByEmail(pool, email);
    const allowed = user ? user.status === 'active' : canSignUp(email);
    // The response is the same whether or not a code is sent, to avoid account enumeration.
    if (allowed) {
      const issued = await issueCode(pool, {
        secret: config.keyEncryptionSecret,
        limits: config.limits,
        email,
        uid: d.uid,
        ip: req.ip ?? null,
        purpose: user ? 'login' : 'signup',
      });
      if (issued.ok) {
        const link = `${config.issuer}/interaction/${d.uid}/link/${issued.linkToken}`;
        // Not awaited: the response must not reveal whether a mail was sent.
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
    res.send(codePage(ctx, `${base(d.uid)}/code`));
  });

  router.post('/interaction/:uid/code', form, async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    const result = await verifyCode(
      pool,
      config.keyEncryptionSecret,
      d.uid,
      String(req.body.code ?? ''),
    );
    if (!result.ok) {
      await audit(pool, { action: 'code_failed', ip: req.ip, details: { locked: result.locked } });
      return void res.status(400).send(codePage(ctxOf(req), `${base(d.uid)}/code`, 'invalid_code'));
    }
    await afterVerified(req, res, d.uid, result.email);
  });

  // Mail scanners prefetch links, so GET never signs anyone in.
  router.get('/interaction/:uid/link/:token', async (req, res) => {
    const ctx = ctxOf(req);
    const d = await details(req, res);
    const link = await verifyLink(
      pool,
      config.keyEncryptionSecret,
      req.params.uid,
      req.params.token,
      { consume: false },
    );
    if (!link.ok) return void res.status(400).send(linkInvalidPage(ctx));
    if (d && d.uid === req.params.uid) return void res.send(linkConfirmPage(ctx, req.originalUrl));
    res.send(linkCodePage(ctx, link.code));
  });

  router.post('/interaction/:uid/link/:token', async (req, res) => {
    const d = await details(req, res);
    if (!d || d.uid !== req.params.uid) return expired(req, res);
    const link = await verifyLink(pool, config.keyEncryptionSecret, d.uid, req.params.token, {
      consume: true,
    });
    if (!link.ok) {
      await audit(pool, { action: 'code_failed', ip: req.ip, details: { via: 'link' } });
      return expired(req, res);
    }
    await afterVerified(req, res, d.uid, link.email);
  });

  router.get('/interaction/:uid/name', async (req, res) => {
    const d = await details(req, res);
    const verified = d && (await getVerified(pool, d.uid));
    if (!d || !verified) return expired(req, res);
    res.send(namePage(ctxOf(req), `${base(d.uid)}/name`, displayNameFromEmail(verified.email)));
  });

  router.post('/interaction/:uid/name', form, async (req, res) => {
    const d = await details(req, res);
    const verified = d && (await getVerified(pool, d.uid));
    if (!d || !verified) return expired(req, res);
    if (!canSignUp(verified.email) || (await findUserByEmail(pool, verified.email)))
      return expired(req, res);
    const name =
      String(req.body.name ?? '')
        .trim()
        .slice(0, 100) || displayNameFromEmail(verified.email);
    let id;
    try {
      id = await createUser(pool, verified.email, config.defaultGroups, name);
    } catch (err) {
      // Two requests for one address both passed the check above; the unique constraint decides.
      if (/** @type {any} */ (err)?.code === '23505') return expired(req, res);
      throw err;
    }
    await consume(pool, verified.id);
    await finishLogin(req, res, id, 'signup');
  });

  router.post('/interaction/:uid/confirm', form, async (req, res) => {
    const d = await details(req, res);
    if (!d) return expired(req, res);
    const { prompt, params, session } = d;
    const grant = d.grantId
      ? await getProvider().Grant.find(d.grantId)
      : new (getProvider().Grant)({ accountId: session.accountId, clientId: params.client_id });
    if (prompt.details.missingOIDCScope)
      grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
    if (prompt.details.missingOIDCClaims) grant.addOIDCClaims(prompt.details.missingOIDCClaims);
    const grantId = await grant.save();
    await getProvider().interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  });

  router.post('/interaction/:uid/confirm/abort', form, async (req, res) => {
    await getProvider().interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'The user denied the request' },
      { mergeWithLastSubmission: false },
    );
  });

  return router;
}
