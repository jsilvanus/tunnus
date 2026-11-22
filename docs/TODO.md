# Tunnus: roadmap

Phased build list for [`plan.md`](plan.md). Tick items as they land; add
notes or deviations next to the item rather than deleting it.

## Phase 0: Repository setup

- [x] `package.json` (`"type": "module"`, Node 24 engines), `.nvmrc`
- [x] ESLint, Prettier, `tsc --noEmit` with JSDoc types (`checkJs`)
- [x] Vitest configured; `npm test`, `npm run test:integration`
- [x] `.env.example` with every variable from the plan
- [x] `docker-compose.yml` with PostgreSQL 16 for development
- [x] CI workflow: format, lint, typecheck, unit tests, integration tests
      against a Postgres service, Docker build
- [x] README: what Tunnus is, quick start, configuration pointer
- [x] LICENSE (decide licence; open question in the plan)

## Phase 1: Spike, a working code flow

Goal: a real relying party signs in through Tunnus and receives `groups`.

- [x] Express 5 app mounting `oidc-provider` under the issuer's path
- [x] Config loader with validation (`ISSUER`, `DATABASE_URL`,
      `CLIENTS_FILE`, secrets)
- [x] Migration runner and first migration: `users`, `groups`,
      `user_groups`, `oidc_payloads`, `signing_keys`, `schema_migrations`
- [x] PostgreSQL adapter for `oidc-provider`
- [x] Signing key generated on first start, stored encrypted, served in
      JWKS (RS256)
- [x] `findAccount` and claims: `sub`, `email`, `email_verified`, `name`,
      `groups`; `conformIdTokenClaims: false`
- [x] Clients loaded from `CLIENTS_FILE` (`client_secret_basic` and
      `client_secret_post`, redirect and post-logout URIs, `first_party`,
      `always_include_groups`)
- [x] Minimal interaction pages: email, code, consent; codes printed to
      the console sender; in the spike codes are held in memory (moved to
      `email_codes` in phase 2)
- [x] Path-prefixed issuer works behind a proxy without prefix stripping
- [x] End-to-end test with `openid-client`: authorize with PKCE, token,
      ID token validation, userinfo, logout
- [ ] Manual check against one existing OIDC client app (the automated
      flow test uses `openid-client` as a real relying party)

## Phase 2: Accounts and email

- [x] `email_codes` table; 6-digit code and separate link token, both
      hashed, 10-minute expiry, 5 attempts, single use
- [x] Mail senders: console, SMTP (Nodemailer), Brevo; templates in
      `fi`, `sv`, `en`
- [x] Sign-up limited by `SIGNUP_EMAIL_ALLOW` / `SIGNUP_EMAIL_DENY` rules
      (module and tests in `src/emailRules.js`); admin-created users
      allowed from any address
- [x] Same response for known and unknown addresses
- [x] Link opens a confirmation page; sign-in only on `POST`; link in
      another browser shows the code instead
- [x] Display-name step for new users, prefilled from the email local part
      and editable; join `DEFAULT_GROUPS`
- [x] Existing session: "Continue as <account>" / "Sign in with another
      account"; honour `prompt=none` and `prompt=login`
- [x] Sliding session (`SESSION_TTL_DAYS`)
- [x] Rate limits per IP and per email; daily mail cap
- [x] `audit_events` table and audit writes for sign-in, sign-up,
      failed codes, rate-limit hits
- [x] Disabled users cannot sign in
- [x] Branding and locale settings on all end-user pages
- [x] Security headers: CSP without inline scripts, HSTS,
      `frame-ancestors 'none'`
- [x] Tests for every rule above

## Phase 3: Admin API

- [x] `openapi.yaml` for `/admin/api/v1`: users, groups, memberships,
      admin tokens, keys, audit events, clients (read-only)
- [x] Request and response validation from the spec
- [x] `admin_tokens` table; bearer auth; tokens tied to `is_admin` users
- [x] `tunnus-admin bootstrap --email …` creates the first admin and
      prints a token once
- [x] Users: list, get, create, update (email, name, status), delete
- [x] Groups: list, create, update, delete (not default groups)
- [x] Memberships: grant, revoke, list by user and by group
- [x] Disabling or deleting a user ends sessions and revokes refresh
      tokens
- [x] Keys: list, rotate, retire; JWKS keeps retired keys for a grace
      period
- [x] Audit: list with filters and paging; every admin call audited
- [x] Integration tests for each operation and for auth failures

## Phase 4: CLI and MCP server

- [x] CLI that reads `openapi.yaml` and maps each `operationId` to a
      command, with `--json` output and table output by default
      (command names from `x-tunnus-cli`; the `operationId` also works)
- [x] CLI config: issuer URL and admin token from env or a config file
      (token file via `--token-file`; the token is never a flag value)
- [x] MCP server (stdio and Streamable HTTP) exposing the same operations
      as tools, with read-only and destructive annotations
- [x] Destructive operations excluded from MCP (delete user, revoke all
      sessions, rotate or retire keys). Note: delete group is destructive
      too and is excluded; admin token create and revoke are excluded
      as `x-tunnus-mcp: false` (token values stay out of AI contexts)
- [x] Tests: CLI command generation, MCP tool list and one call each
      (in-memory and over HTTP). Note: stdio and the `--http` listener were
      checked by hand against a running Tunnus, not in the automated tests

## Phase 5: Production readiness

Design: [`production.md`](production.md).

- [x] Multi-stage Dockerfile, non-root user, `HEALTHCHECK`
- [x] `<issuer>/health` with database and key status
- [x] Prometheus `/metrics` behind `METRICS_BEARER_TOKEN`: sign-ins,
      sign-ups, failed codes, mail errors, rate-limit hits
- [x] Audit retention cleanup job; strip audit IPs after `AUDIT_IP_RETENTION_DAYS`
- [x] Inactive-user job: warning email at `INACTIVE_USER_WARN_DAYS` before
      deletion, delete after `INACTIVE_USER_DELETE_DAYS`. Note: warnings are
      capped at `MAIL_DAILY_CAP` per run, not counted against the sign-in
      code limit
- [x] Privacy notice page rendered from `CONTROLLER_*` and `PROCESSORS` env
- [x] Expired `oidc_payloads` and `email_codes` cleanup job
- [x] Image published to GHCR from CI on tags. Note: not yet run
- [x] Deployment guide: reverse proxy with a path prefix, database,
      backups, key rotation schedule
- [x] Brevo templates for the sign-in code and the inactivity warning, per
      locale, with plain text as the fallback (`docs/deployment.md`, "Brevo templates")
- [x] Privacy notice template and data-retention notes
- [ ] OpenID conformance suite, basic OP profile, against a test instance
      Note: manual; see docs/conformance.md

## Later

- [ ] Admin web UI on the admin API
- [ ] Clients managed in the database through the admin API
- [ ] Passkeys (WebAuthn), once a deployment's domain is final
- [ ] Self-service email change with verification of the new address
- [ ] Secondary email address: keep primary `email` as the username/claim, but send sign-in codes (and optionally inactivity warnings) to both primary and secondary addresses
- [x] Back-channel logout & MCP revocation (OpenID Connect Back-Channel Logout 1.0 & CAEP):
      Enable `features.backchannelLogout` in `oidc-provider` and register `backchannel_logout_uri` on clients (Vuorot, Tavaranpaikka, PTV-MCP, etc.).
      Trigger back-channel logout and MCP revocation when user rights/groups are removed, app access is revoked from `/account`, or a user is disabled / session terminated, so client applications can immediately destroy the user's active session and revoke MCP tokens. See [`mcp-centralization-plan.md`](mcp-centralization-plan.md).
- [x] Centralize downstream MCP OAuth on Tunnus (RFC 9728 / RFC 8707):
      Support downstream resource indicators in `oidc-provider`, show target resources for authorized applications on `/account`, and dispatch back-channel revocation signals. See [`mcp-centralization-plan.md`](mcp-centralization-plan.md).
- [ ] User export for data-subject access requests

## Review follow-ups (2026-11-17)

From [`reviews/2026-11-17-code-review.md`](reviews/2026-11-17-code-review.md). IDs refer to that file.

- [x] H1 `TRUST_PROXY=1` must become a number (rate limits and audit IPs are wrong behind a proxy)
- [x] M1 Refuse `MAIL_PROVIDER=console` in production
- [x] M2 Validate secrets (length, placeholders); derive a subkey per purpose
- [x] M3 Cache the derived key; no `scryptSync` per encrypt/decrypt
- [x] M4 `pool.on('error')`, pool and statement timeouts
- [x] M5 Advisory lock around migrations
- [x] M6 Sign-in limits: reserve for existing users, atomic count, lockout (per-IP interaction limit skipped: not required, the per-IP code limit already applies)
- [x] M7 Do not await mail send in `/email` (timing oracle)
- [x] M8 Timeouts for Brevo and SMTP sends
- [x] M9 Audit `err.name`, not `String(err)`, for mail errors
- [x] M10 Request logging, error middleware, branded error page
- [x] L1 `email_verified` semantics in `docs/security.md` (documented rule; the claim is not changed)
- [x] L2 `POST /continue` checks the session user is active
- [x] L3 `always_include_groups` covered for `POST /auth` and tested (POST /auth is not served: `enableHttpPostMethods` is off, so the GET rewrite covers every path; a test asserts the 404; pushed requests and request objects are off and documented, not rewritten)
- [x] L4 first-party grants gain later-requested scopes; tested
- [x] L5 valid admin token accepted when the IP is over the failure limit
- [x] L6 admin token model documented in `docs/security.md` (no scopes yet: add them before tokens go to automation)
- [x] L7 `POST /name` unique violation shows the expired page
- [x] L8 `src/emailAddress.js` replaces the loose email check (the admin API validates `format: email` from openapi.yaml and has no separate check, so it is unchanged)
- [x] L9 `last_login_at` updated on `authorization.success` / `grant.success`, hourly
- [x] L10 Supply chain: `permissions`, concurrency, `npm audit`, Dependabot, deploy workflow . Skipped: pinning actions by commit SHA and the base image by digest. Dependabot now proposes updates for both, and the pins are a separate change that needs a decision on who reviews them.
- [x] L11 Branded logout pages, `features.revocation` enabled (back-channel logout remains on the Later list)
- [x] L12 `grant_types` documented in `clients.example.json` and `docs/deployment.md` (README notes it too)
- [x] L13 Failed-verification lockout across interactions (10 per email per hour)
- [x] L14 Code storage and threat model in `docs/security.md`
- [ ] Run the OpenID conformance suite after H1 to M10 are fixed
