import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createUser, findUserByEmail } from '../accounts.js';
import { createSignupRule } from '../emailRules.js';
import { codePage, consentPage, emailPage } from './pages.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** @param {string} s */
const hash = (s) => createHash('sha256').update(s).digest();

/**
 * End-user interaction pages: email, code and consent.
 * Phase 1 spike: codes are held in memory; phase 2 moves them to `email_codes`.
 * @param {{ config: import('../config.js').Config, pool: import('pg').Pool, provider: any, mailer: import('../mail.js').Mailer }} deps
 */
export function createInteractionRouter({ config, pool, provider, mailer }) {
  const router = express.Router();
  const canSignUp = createSignupRule({ allow: config.signupAllow, deny: config.signupDeny });
  /** @type {Map<string, { email: string, codeHash: Buffer, expires: number, attempts: number }>} */
  const pending = new Map();
  const form = express.urlencoded({ extended: false });
  const noStore = (/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  router.use(noStore);

  router.get('/interaction/:uid', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const base = `${config.basePath}/interaction/${details.uid}`;
    if (details.prompt.name === 'login') return void res.send(emailPage(config, `${base}/email`));
    const client = await provider.Client.find(details.params.client_id);
    const scopes = String(details.params.scope ?? '')
      .split(' ')
      .filter(Boolean);
    res.send(
      consentPage(
        config,
        `${base}/confirm`,
        client?.clientName ?? details.params.client_id,
        scopes,
      ),
    );
  });

  router.post('/interaction/:uid/email', form, async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const base = `${config.basePath}/interaction/${details.uid}`;
    const email = String(req.body.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email))
      return void res.send(emailPage(config, `${base}/email`, 'Enter a valid email address.'));
    const user = await findUserByEmail(pool, email);
    const allowed = user ? user.status === 'active' : canSignUp(email);
    // Same response whether or not a code is sent, to avoid account enumeration.
    if (allowed) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      pending.set(details.uid, {
        email,
        codeHash: hash(code),
        expires: Date.now() + CODE_TTL_MS,
        attempts: 0,
      });
      await mailer.sendCode(email, code, null);
    } else {
      pending.delete(details.uid);
    }
    res.send(codePage(config, `${base}/code`));
  });

  router.post('/interaction/:uid/code', form, async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const base = `${config.basePath}/interaction/${details.uid}`;
    const entry = pending.get(details.uid);
    const fail = () =>
      res.status(400).send(codePage(config, `${base}/code`, 'That code is not valid.'));
    if (!entry || entry.expires < Date.now() || entry.attempts >= MAX_ATTEMPTS) return void fail();
    entry.attempts += 1;
    const given = hash(String(req.body.code ?? '').trim());
    if (!timingSafeEqual(given, entry.codeHash)) return void fail();
    pending.delete(details.uid);

    let user = await findUserByEmail(pool, entry.email);
    const id = user?.id ?? (await createUser(pool, entry.email, config.defaultGroups));
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: id } },
      { mergeWithLastSubmission: false },
    );
  });

  router.post('/interaction/:uid/confirm', form, async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const { prompt, params, session } = details;
    const grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({ accountId: session.accountId, clientId: params.client_id });
    if (prompt.details.missingOIDCScope)
      grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
    if (prompt.details.missingOIDCClaims) grant.addOIDCClaims(prompt.details.missingOIDCClaims);
    const grantId = await grant.save();
    await provider.interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  });

  router.post('/interaction/:uid/confirm/abort', form, async (req, res) => {
    await provider.interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'The user denied the request' },
      { mergeWithLastSubmission: false },
    );
  });

  return router;
}
