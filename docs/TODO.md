# Tunnus: roadmap

Phased build list for [`plan.md`](plan.md). Tick items as they land; add
notes or deviations next to the item rather than deleting it.

## Phase 0: Repository setup

- [ ] `package.json` (`"type": "module"`, Node 24 engines), `.nvmrc`
- [ ] ESLint, Prettier, `tsc --noEmit` with JSDoc types (`checkJs`)
- [ ] Vitest configured; `npm test`, `npm run test:integration`
- [ ] `.env.example` with every variable from the plan
- [ ] `docker-compose.yml` with PostgreSQL 16 for development
- [ ] CI workflow: format, lint, typecheck, unit tests, integration tests
      against a Postgres service, Docker build
- [ ] README: what Tunnus is, quick start, configuration pointer
- [ ] LICENSE (decide licence)

## Phase 1: Spike, a working code flow

Goal: a real relying party signs in through Tunnus and receives `groups`.

- [ ] Express 5 app mounting `oidc-provider` under the issuer's path
- [ ] Config loader with validation (`ISSUER`, `DATABASE_URL`,
      `CLIENTS_FILE`, secrets)
- [ ] Migration runner and first migration: `users`, `groups`,
      `user_groups`, `oidc_payloads`, `signing_keys`, `schema_migrations`
- [ ] PostgreSQL adapter for `oidc-provider`
- [ ] Signing key generated on first start, stored encrypted, served in
      JWKS (RS256)
- [ ] `findAccount` and claims: `sub`, `email`, `email_verified`, `name`,
      `groups`; `conformIdTokenClaims: false`
- [ ] Clients loaded from `CLIENTS_FILE` (`client_secret_basic` and
      `client_secret_post`, redirect and post-logout URIs, `first_party`,
      `always_include_groups`)
- [ ] Minimal interaction pages: email, code, consent; codes printed to
      the console sender
- [ ] Path-prefixed issuer works behind a proxy without prefix stripping
- [ ] End-to-end test with `openid-client`: authorize with PKCE, token,
      ID token validation, userinfo, logout
- [ ] Manual check against one existing OIDC client app

## Phase 2: Accounts and email

- [ ] `email_codes` table; 6-digit code and separate link token, both
      hashed, 10-minute expiry, 5 attempts, single use
- [ ] Mail senders: console, SMTP (Nodemailer), Brevo; templates in
      `fi`, `sv`, `en`
- [ ] Sign-up limited to `SIGNUP_EMAIL_DOMAINS`; admin-created users
      allowed from any domain
- [ ] Same response for known and unknown addresses
- [ ] Link opens a confirmation page; sign-in only on `POST`; link in
      another browser shows the code instead
- [ ] Display-name step for new users; join `DEFAULT_GROUPS`
- [ ] Existing session: "Continue as <account>" / "Sign in with another
      account"; honour `prompt=none` and `prompt=login`
- [ ] Sliding session (`SESSION_TTL_DAYS`)
- [ ] Rate limits per IP and per email; daily mail cap
- [ ] `audit_events` table and audit writes for sign-in, sign-up,
      failed codes, rate-limit hits
- [ ] Disabled users cannot sign in
- [ ] Branding and locale settings on all end-user pages
- [ ] Security headers: CSP without inline scripts, HSTS,
      `frame-ancestors 'none'`
- [ ] Tests for every rule above

## Phase 3: Admin API

- [ ] `openapi.yaml` for `/admin/api/v1`: users, groups, memberships,
      admin tokens, keys, audit events, clients (read-only)
- [ ] Request and response validation from the spec
- [ ] `admin_tokens` table; bearer auth; tokens tied to `is_admin` users
- [ ] `tunnus-admin bootstrap --email …` creates the first admin and
      prints a token once
- [ ] Users: list, get, create, update (email, name, status), delete
- [ ] Groups: list, create, update, delete (not default groups)
- [ ] Memberships: grant, revoke, list by user and by group
- [ ] Disabling or deleting a user ends sessions and revokes refresh
      tokens
- [ ] Keys: list, rotate, retire; JWKS keeps retired keys for a grace
      period
- [ ] Audit: list with filters and paging; every admin call audited
- [ ] Integration tests for each operation and for auth failures

## Phase 4: CLI and MCP server

- [ ] CLI that reads `openapi.yaml` and maps each `operationId` to a
      command, with `--json` output and table output by default
- [ ] CLI config: issuer URL and admin token from env or a config file
- [ ] MCP server (stdio and Streamable HTTP) exposing the same operations
      as tools, with read-only and destructive annotations
- [ ] Destructive operations excluded from MCP (delete user, revoke all
      sessions, rotate or retire keys)
- [ ] Tests: CLI command generation, MCP tool list and one call each

## Phase 5: Production readiness

- [ ] Multi-stage Dockerfile, non-root user, `HEALTHCHECK`
- [ ] `<issuer>/health` with database and key status
- [ ] Prometheus `/metrics` behind `METRICS_BEARER_TOKEN`: sign-ins,
      sign-ups, failed codes, mail errors, rate-limit hits
- [ ] Audit retention cleanup job
- [ ] Expired `oidc_payloads` and `email_codes` cleanup job
- [ ] Image published to GHCR from CI on tags
- [ ] Deployment guide: reverse proxy with a path prefix, database,
      backups, key rotation schedule
- [ ] Privacy notice template and data-retention notes
- [ ] OpenID conformance suite, basic OP profile, against a test instance

## Later

- [ ] Admin web UI on the admin API
- [ ] Clients managed in the database through the admin API
- [ ] Passkeys (WebAuthn), once a deployment's domain is final
- [ ] Self-service email change with verification of the new address
- [ ] Back-channel logout to clients
- [ ] User export for data-subject access requests
