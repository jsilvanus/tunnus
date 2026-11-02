# Tunnus: plan

Tunnus is a small, self-hosted OpenID Connect provider. Users sign in with
a one-time code sent to their email address, and nothing else: there are no
passwords. Tunnus gives each user a stable `sub`, a verified `email`, a
display `name` and a `groups` claim, so that a handful of applications can
share one account and use groups for access decisions.

It is meant for small organisations that want single sign-on for their own
apps without running a large identity server, and that can prove who
someone is by mailbox access to an allowed email domain.

This document is the design rationale. The phased build list lives in
[`TODO.md`](TODO.md).

## Goals

- A standards-compliant OpenID Connect provider: authorization code flow
  with PKCE, discovery, JWKS, userinfo, RP-initiated logout, refresh tokens.
- Passwordless sign-in by an emailed one-time code (or a link to the same
  code).
- Self-service sign-up limited to configured email domains.
- Groups: default groups every user joins at sign-up, and other groups
  granted by an administrator. Groups are emitted in the `groups` claim.
- Administration through an HTTP API described by OpenAPI, with a CLI and
  an MCP server built on that API. No admin web UI in the first version.
- Small footprint: one Node.js process and one PostgreSQL database, about
  100 MB of RAM, deployable as a single Docker image.
- Everything deployment-specific (domains, groups, clients, branding,
  language) comes from configuration. The repository contains no
  organisation-specific names.

## Non-goals (for now)

- Federation with other identity providers (social login, SAML, upstream
  OIDC). Email possession is the only proof of identity.
- Passwords. There is nothing to reset or leak.
- Passkeys / WebAuthn. Planned for later; a passkey is bound to the
  domain, so it should only be added once a deployment's final domain is
  known.
- Dynamic client registration. Clients are declared in configuration.
- Self-service group requests or group administration by end users.
- An admin web UI. The API is designed so that one can be added later.

## Architecture

| Part      | Choice                                                                                            | Why                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Runtime   | Node.js 24, ESM only                                                                              | Current LTS                                                                                    |
| Protocol  | [`oidc-provider`](https://github.com/panva/node-oidc-provider)                                    | Certified OpenID Provider library; we write only accounts, interactions and storage glue       |
| Web       | Express 5, server-rendered HTML for end-user pages only                                           | Email, code, account choice, consent and logout are a few small forms; no front-end build step |
| Storage   | PostgreSQL 16, `pg`, plain SQL migrations                                                         | Survives restarts, no Redis; one database per deployment                                       |
| Email     | Pluggable sender: SMTP (Nodemailer) and Brevo transactional API; a console sender for development | Small deployments already have one of these                                                    |
| Logging   | Pino, structured JSON                                                                             |                                                                                                |
| Metrics   | Prometheus `/metrics` behind a bearer token                                                       |                                                                                                |
| Packaging | Multi-stage Dockerfile, non-root user, health check                                               |                                                                                                |

### Issuer and path prefix

The issuer is configured as a full URL and may contain a path, for example
`https://id.example.org` or `https://www.example.org/id`. Tunnus mounts
everything under that path, so a reverse proxy can route a path prefix to
it without stripping the prefix. Discovery is then at
`<issuer>/.well-known/openid-configuration`, and cookies are scoped to the
path.

The issuer value is emitted exactly as configured, with no trailing slash
added or removed, because many clients compare it byte for byte.

### Stable subject

`sub` is a random UUID created with the user and never reused or changed,
even when the user's email address changes. A deployment that later moves
to another domain changes only the issuer URL; clients that key accounts
by a provider name plus `sub` keep working.

## Data model

| Table               | Key columns                                                                                                                        | Notes                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `users`             | `id` uuid (= `sub`), `email` unique lowercase, `display_name`, `status` active/disabled, `is_admin`, `created_at`, `last_login_at` |                                                                                            |
| `groups`            | `id`, `name` unique, `description`                                                                                                 | Groups in `DEFAULT_GROUPS` are created at start and cannot be deleted                      |
| `user_groups`       | `user_id`, `group_id`, `granted_by`, `granted_at`                                                                                  | Default groups are added at sign-up; others only by an admin                               |
| `email_codes`       | `id`, `email`, `code_hash`, `link_token_hash`, `purpose` signup/login, `interaction_uid`, `attempts`, `expires_at`, `consumed_at`  |                                                                                            |
| `oidc_payloads`     | `id`, `type`, `payload` jsonb, `grant_id`, `uid`, `user_code`, `expires_at`, `consumed_at`                                         | The `oidc-provider` adapter: sessions, interactions, codes, tokens and grants in one table |
| `signing_keys`      | `kid`, `alg`, `private_jwk` encrypted, `status` next/active/retired, `created_at`, `activated_at`, `retired_at`                    | Encrypted with a key from the environment                                                  |
| `admin_tokens`      | `id`, `user_id`, `token_hash`, `label`, `expires_at`, `last_used_at`, `revoked_at`                                                 | For the CLI and MCP server; tied to a user with `is_admin`                                 |
| `audit_events`      | `id`, `at`, `actor_user_id`, `action`, `target_type`, `target_id`, `ip`, `details` jsonb                                           | Append-only; no email addresses or codes in `details`                                      |
| `schema_migrations` | `name`, `applied_at`                                                                                                               |                                                                                            |

Clients are declared in a JSON file (`CLIENTS_FILE`) in the first version.
A deployment typically has a few clients that change only with deploys.
Client secrets in that file can reference environment variables so the
file itself can be committed to a private config repository.

### Claims

| Scope     | Claims                                                         |
| --------- | -------------------------------------------------------------- |
| `openid`  | `sub`                                                          |
| `email`   | `email`, `email_verified` (always `true`)                      |
| `profile` | `name`                                                         |
| `groups`  | `groups`: array of group names, e.g. `["staff", "team/alpha"]` |

Group names are plain strings with no leading slash. `/` may be used as a
separator by convention (for example `team/alpha`), but Tunnus gives it no
meaning.

Some clients read groups only from the ID token. Tunnus therefore puts
requested claims into the ID token as well as userinfo
(`conformIdTokenClaims: false`), and a client can be configured to receive
`groups` even if it does not request the `groups` scope
(`always_include_groups` in the client file).

## User flows

### Sign-in and sign-up

Sign-in and sign-up are the same flow.

1. A client sends the browser to `<issuer>/auth` with PKCE.
2. If a Tunnus session exists, Tunnus shows **"Continue as &lt;account&gt;"**
   and **"Sign in with another account"**. Continuing returns to the client
   with an authorization code. A client can skip this page with
   `prompt=none`, or force a fresh sign-in with `prompt=login`.
3. Otherwise Tunnus asks for an email address. Sign-up is allowed only for
   domains in `SIGNUP_EMAIL_DOMAINS`; a user created by an admin may have
   any address. The response is the same whether the address is known or
   not, to avoid account enumeration.
4. Tunnus emails a 6-digit code and a link carrying a separate one-time
   token.
5. The user types the code, or opens the link. The link opens a
   confirmation page with a button and never completes sign-in on `GET`,
   because mail security scanners (for example Microsoft Safe Links)
   prefetch every link in a message. A link opened in another browser
   than the one that started the flow shows the code to type instead.
6. A new user is asked for a display name. Tunnus creates the user and
   adds them to the default groups.
7. Clients marked `first_party` skip consent. Tunnus redirects back with
   the code.

### Sign-out

`<issuer>/session/end` ends the Tunnus session and redirects to one of the
client's registered post-logout URLs.

### Account changes

In the first version, email changes, group changes and disabling a user
are admin operations. Disabling a user ends their sessions and revokes
their refresh tokens.

## Administration

The admin surface is an HTTP API at `<issuer>/admin/api/v1`. Its contract
is `openapi.yaml` in the repository; request validation and the
documentation come from that file.

Resources: users, groups, group memberships, admin tokens, signing keys,
audit events, clients (read-only while clients live in a file).

Two thin clients use the API:

- **CLI** (`tunnus …`). It reads `openapi.yaml` and exposes each
  `operationId` as a command, so it cannot drift from the API. Examples:
  `tunnus users list`, `tunnus groups grant --user … --group …`,
  `tunnus keys rotate`.
- **MCP server**. It registers the same operations as MCP tools for
  AI-assisted administration. Destructive operations (delete user, revoke
  all sessions, rotate or retire keys) are left out of the MCP server
  until it has been in use for a while; they stay CLI-only.

Both authenticate with an admin token: an opaque random string stored
only as a hash, tied to a user with `is_admin`, with an expiry. Every
admin call writes an audit event naming that user.

The first admin is created inside the container with a one-off command
(`tunnus-admin bootstrap --email …`) that prints an admin token once.

## Security

| Area         | Plan                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codes        | 6 digits from a CSPRNG, stored as a hash, valid 10 minutes, 5 wrong attempts invalidate the code, single use                                                                                            |
| Rate limits  | Per IP and per email address: code emails and attempts per hour, configurable; a daily cap on outgoing mail as a backstop                                                                               |
| Tokens       | Authorization code 60 s, access token 10 min, refresh token 30 days with rotation, only for clients allowed `offline_access`                                                                            |
| Signing keys | RS256 by default (widest client support). One `active` and one `next` key, both published in JWKS. Rotation promotes `next`, creates a new `next`, and keeps the retired key in JWKS for a grace period |
| Key storage  | Private keys encrypted at rest with `KEY_ENCRYPTION_SECRET`                                                                                                                                             |
| Cookies      | `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to the issuer path, signed with `COOKIE_SECRETS` (a list, so it can rotate)                                                                                |
| Clients      | Confidential clients use `client_secret_basic` or `client_secret_post`, set per client; public clients must use PKCE                                                                                    |
| Admin API    | Admin tokens only; no cookie auth, so no CSRF surface                                                                                                                                                   |
| Audit        | Sign-in, sign-up, failed codes, rate-limit hits, admin actions, key rotations; retention configurable (default 365 days)                                                                                |
| Privacy      | Stores only email, display name, group membership and audit metadata. Deleting a user removes the user row; audit rows keep only the `sub`. See [Personal data](#personal-data)                         |
| Headers      | Strict CSP with no inline scripts, HSTS, `frame-ancestors 'none'`                                                                                                                                       |

## Configuration

All settings come from environment variables; `.env.example` documents
them.

| Variable                                                            | Purpose                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ISSUER`                                                            | Full issuer URL, may include a path                                                                                       |
| `DATABASE_URL`                                                      | PostgreSQL connection                                                                                                     |
| `SIGNUP_EMAIL_DOMAINS`                                              | Comma-separated domains allowed to self-register; empty closes sign-up                                                    |
| `DEFAULT_GROUPS`                                                    | Comma-separated groups every new user joins                                                                               |
| `CLIENTS_FILE`                                                      | Path to the clients JSON file                                                                                             |
| `KEY_ENCRYPTION_SECRET`                                             | Encrypts signing keys at rest                                                                                             |
| `COOKIE_SECRETS`                                                    | Comma-separated cookie signing keys, newest first                                                                         |
| `MAIL_PROVIDER`                                                     | `smtp`, `brevo` or `console`                                                                                              |
| `MAIL_FROM`, `SMTP_URL`, `BREVO_API_KEY`                            | Mail settings                                                                                                             |
| `SESSION_TTL_DAYS`                                                  | Sliding Tunnus session length (default 14)                                                                                |
| `BRAND_NAME`, `BRAND_LOGO_URL`, `BRAND_COLOR`, `PRIVACY_NOTICE_URL` | Branding of the end-user pages                                                                                            |
| `DEFAULT_LOCALE`                                                    | `fi`, `sv` or `en`                                                                                                        |
| `METRICS_BEARER_TOKEN`                                              | Enables `/metrics`                                                                                                        |
| `TRUST_PROXY`                                                       | Express proxy trust setting for correct client IPs                                                                        |
| `INACTIVE_USER_DELETE_DAYS`                                         | Delete accounts with no sign-in for this many days (default 730; `0` disables)                                            |
| `INACTIVE_USER_WARN_DAYS`                                           | Email a warning this many days before deletion (default 30)                                                               |
| `AUDIT_RETENTION_DAYS`                                              | Delete audit rows after this many days (default 365)                                                                      |
| `AUDIT_IP_RETENTION_DAYS`                                           | Remove the IP address from audit rows after this many days (default 30)                                                   |
| `CONTROLLER_NAME`, `CONTROLLER_CONTACT`, `DPO_CONTACT`              | Data controller identity and contact details shown in the privacy notice and mail footers                                 |
| `PROCESSORS`                                                        | JSON list (or `PROCESSORS_FILE` path) of processors, each with `name`, `purpose`, `location`; shown in the privacy notice |

## Personal data

Tunnus stores an email address, a display name, group membership, sign-in
times and audit metadata. Defaults, all configurable:

- **Inactive accounts** are deleted after 730 days without a sign-in
  (`INACTIVE_USER_DELETE_DAYS`). A warning email is sent 30 days before
  (`INACTIVE_USER_WARN_DAYS`); signing in cancels the deletion.
- **Audit rows** are kept 365 days (`AUDIT_RETENTION_DAYS`). The IP address
  is removed from audit rows after 30 days (`AUDIT_IP_RETENTION_DAYS`).
- **Display name** is prefilled from the email local part
  (`firstname.lastname@example.org` becomes "Firstname Lastname") and the
  user can edit it before the account is created and afterwards.
- **Controller and processors** are not hardcoded. The controller's identity
  and contact details, and the list of processors (mail provider, hosting),
  come from environment variables and are rendered in the privacy notice
  page and mail footers. The deployment decides who the controller is.
- A privacy notice page is served at `<issuer>/privacy`; `PRIVACY_NOTICE_URL`
  can point elsewhere instead.

## Operations

- **Cleanup:** a daily job removes expired codes and payloads, warns and
  deletes inactive users, strips old audit IPs and deletes old audit rows.
- **Health:** `<issuer>/health` returns database and key status.
- **Backups:** the deployment backs up the PostgreSQL database; Tunnus has
  no other state.
- **Key rotation:** `tunnus keys rotate` on a schedule (for example every
  90 days).
- **Upgrades:** migrations run at start, are forward-only and idempotent.
- **Outage:** while Tunnus is down, no one can sign in to clients through
  it. Clients should keep a local break-glass login for their own
  administrators.

## Testing

- Unit tests with Vitest.
- HTTP tests with Supertest against a real PostgreSQL.
- An end-to-end code flow test using `openid-client` as a relying party,
  covering PKCE, ID token validation, userinfo, refresh and logout.
- Optionally, the OpenID Foundation conformance suite (basic OP profile)
  against a deployed test instance.

## Open questions

- Licence and whether the repository is public from the start.
- Default session length (14 days sliding is proposed).
- Whether clients should move from a file to the database (and the admin
  API) once there are more than a handful.
- Passkeys: when, and whether as a second factor or a replacement for the
  email code.
