# Code review: main at 1209b21 (phases 0 to 5)

Date: 2026-11-17. Scope: the whole repository on `main` after the phase 5 merge (#9):
security, correctness, OpenID Connect behaviour and operations. Reviewed by reading the
code in `src/`, `bin/`, `migrations/`, `openapi.yaml`, the Dockerfile and the workflows.

Gates run for this review: `npm test` (138 unit tests pass), `npm run typecheck`,
`npm run lint` and `npm audit --omit=dev` (0 vulnerabilities) are all clean. The
integration and CLI/MCP suites were not run (they need PostgreSQL), and the OpenID
conformance suite has not been run (see `docs/conformance.md`).

No code was changed. Fixes are tracked in `docs/TODO.md` under "Review follow-ups".

## Summary

The design is sound and the code is careful: parameterised SQL everywhere, hashed
tokens, constant-time comparisons, advisory locks for key changes and cleanup, a
last-admin guard, sessions revoked on disable and delete, GET never signs anyone in,
a strict CSP, and an OpenAPI-validated admin API. One bug should be fixed before a real
deployment (H1); the medium items are mostly hardening and operations.

## High

### H1. `TRUST_PROXY=1` is not honoured (verified)

`loadConfig` returns the value as the string `"1"` for anything other than `true` or
`false`. Express treats a numeric string as an address list, not a hop count: I checked
that `app.set('trust proxy', '1')` trusts nothing, while `app.set('trust proxy', 1)`
does. `docs/deployment.md` tells operators to set exactly `1`. Effects behind a reverse
proxy: `req.ip` is the proxy for every request, so the per-IP sign-in limit (20 per hour)
becomes one bucket for all users, the admin auth failure limiter is shared the same way,
and audit IPs are wrong. `provider.proxy` is set from the same truthy string, so it
stays on while Express does not trust the proxy, which is inconsistent.
Fix: in `src/config.js`, turn an all-digit value into a number; add a test; consider a
startup warning when the issuer is https and `TRUST_PROXY` is `false`.

## Medium

### M1. The default mail provider is `console`

With `MAIL_PROVIDER` unset, sign-in codes and links are written to the log. A production
deployment that forgets the setting is both unusable and leaks codes to anyone who can
read logs. Fix: refuse `console` when the issuer is https or `NODE_ENV=production`,
unless an explicit opt-in is set.

### M2. Secrets are not validated and one secret serves three purposes

`KEY_ENCRYPTION_SECRET` and `COOKIE_SECRETS` only have to be non-empty, so the
`change-me` values in `.env.example` start fine. The same secret encrypts signing keys,
keys the code HMAC and encrypts the stored code, with a fixed scrypt salt.
Fix: minimum length, reject the example placeholders, derive one subkey per purpose
(HKDF).

### M3. `scryptSync` runs on every encrypt and decrypt

`deriveKey` in `src/oidc/keys.js` runs scrypt each call. Measured: about 36 ms of
blocking CPU per call. It runs for every issued sign-in code and every link view, so an
unauthenticated client can keep the event loop busy. Fix: derive once and cache per
secret (or use HKDF, which is cheap).

### M4. No `error` handler on the `pg` pool

`createPool` attaches no `pool.on('error')`. An error on an idle client (database
restart or failover) is then an unhandled `error` event and ends the process. There is
also no `max`, connection timeout or statement timeout. Fix: add the handler (log, do not
exit), and set sensible timeouts.

### M5. Migrations are not serialised

`migrate()` has no advisory lock. Two instances starting together (rolling deploy,
replicas) can both run a migration; the second fails on the `schema_migrations` primary
key or repeats DDL, and the container restarts. Fix: take `pg_advisory_lock` around the
whole run, as `keys.js` and `cleanup.js` already do for their work.

### M6. Sign-in availability can be attacked

The per-email limit (5 per hour) counts codes issued, regardless of who asked, so anyone
who knows an address can block that person from signing in. The global `MAIL_DAILY_CAP`
(500) can be used up by one actor rotating IPs, which stops sign-in for everyone. The
count-then-insert in `issueCode` is not atomic, so concurrent requests can exceed the
limits. Fix options: limit interaction creation per IP, reserve part of the daily cap for
existing users, serialise per email (advisory lock or a single `INSERT ... WHERE`), and
offer an optional challenge hook.

### M7. Timing reveals whether an address gets a code

`POST /interaction/:uid/email` returns the same page either way, but it awaits the mail
send only for allowed addresses, so response time differs by hundreds of milliseconds.
Fix: send in the background (audit and count failures there), or pad the response.

### M8. Mail sending has no timeout

The Brevo `fetch` has no abort signal and the call is awaited inside the request, so a
hung provider ties up requests. Fix: `AbortSignal.timeout`, and set timeouts on the SMTP
transport.

### M9. Mail errors audit the raw error text

`src/web/interactions.js` writes `details: { message: String(err) }`. Provider and
Nodemailer errors often contain the recipient address, which breaks the rule in
`src/audit.js` (no email addresses in audit details) and is kept for 365 days. The
cleanup job already records only `err.name`. Fix: do the same here.

### M10. No request logging or central error handling

`pino` is used only at start-up and by the cleanup job. The app has no access log, no
Express error middleware and uses `console.error` in places, so a failing sign-in leaves
little to diagnose, and an error in an interaction route returns Express's default page.
Fix: `pino-http` (without query strings, which carry link tokens), an error handler that
logs and returns a branded error page, and a correlation id.

## Low

- **L1. `email_verified` is always `true`.** An admin who changes an address through the
  API leaves the new address unverified while the claim says otherwise. Mark it false
  until the next sign-in by code, or document the rule.
- **L2. `POST /interaction/:uid/continue` does not check the user is active.** Disabling
  revokes sessions, so this is defence in depth only; check `status` as the GET does.
- **L3. `always_include_groups` rewrites the query string only for `GET /auth`.**
  `POST /auth`, request objects and pushed requests bypass it and the client gets no
  `groups` claim. The `ctx.oidc?.route === undefined` condition is always true at that
  point. Add tests for those paths or find a hook that covers every request.
- **L4. First-party grants may go stale.** `loadExistingGrant` returns an existing grant
  unchanged, so scopes requested later are missing from it and the consent page can
  appear for a first-party client. Verify with a scope-change test.
- **L5. The admin auth failure limiter** is in memory (per process), keyed by IP (see
  H1), and also refuses valid tokens from an IP that has exceeded it. Every failure
  below the limit writes an audit row.
- **L6. Admin tokens are all or nothing.** There are no read-only scopes, and any admin
  can mint tokens for another admin. Fine for now; document it and consider scopes before
  tokens are handed to automation.
- **L7. Sign-up race.** Two concurrent `POST /name` calls for one address hit the unique
  constraint and return 500. Map it to the "expired" page.
- **L8. The email check is loose.** `^[^@\s]+@[^@\s]+$` accepts `,`, `;`, `<`, `>` and
  quotes, and Nodemailer parses address lists. Use the stricter pattern from
  `bootstrap.js` and a length limit.
- **L9. Inactivity bookkeeping.** `last_login_at` is updated only on an interactive
  sign-in. A user kept signed in by silent authentication (`prompt=none`) or refresh
  tokens can be warned and then deleted while active.
- **L10. Supply chain.** `ci.yml` has no `permissions` block, actions are pinned by tag
  rather than SHA, there is no Dependabot or image scan, and the base image is not
  pinned by digest. The image workflow has not been run yet.
- **L11. Logout.** RP-initiated logout uses the library's default pages (unbranded,
  English only). Check they render under the CSP (`default-src 'none'`) and add a test.
  Back-channel logout and token revocation (`features.revocation`) are not enabled.
- **L12. Documentation gaps.** `clients.example.json` has no `grant_types`; the default is
  `authorization_code` only, so refresh tokens need `["authorization_code",
"refresh_token"]`. State it where `offline_access` is described.
- **L13. Brute-force budget.** Attempts are counted per code. With 5 codes per hour per
  address and 5 tries each, a patient attacker has about a 0.4 percent chance per week
  against one address. Count failures per address across interactions and lock briefly.
- **L14. Code storage.** The code is stored as an HMAC and also encrypted. A 6-digit HMAC
  is trivially reversible, and the encrypted copy (kept to show the code on the link
  page) is readable with the secret. Acceptable with 10-minute expiry; say so in the
  threat notes.

## OpenID Connect notes

- Good: PKCE required for every client (S256 only in the current library); the
  authorization code is single use and short lived; refresh token rotation is on;
  `sub` is a stable UUID; `prompt=none`, `prompt=login` and the "continue as" step are
  handled; post-logout redirect URIs come from client metadata; JWKS publishes the next
  and recently retired keys, which makes rotation safe.
- Open: the conformance run (basic OP profile) is the real check; the items above that
  touch behaviour (L3, L4, L11) are the likeliest to show up there.
- Not provided yet, already on the roadmap: back-channel logout, dynamic client
  management, passkeys. Token revocation and introspection are off by default in the
  library and are worth enabling when a client needs them.

## Operations notes

- Health, metrics, cleanup with an advisory lock, graceful shutdown and the non-root
  image are in good shape.
- Add: M4, M5 and M10 above, a startup warning for obviously unsafe settings (M1, M2,
  H1), and an alert on `tunnus_cleanup_last_success_timestamp_seconds`.
