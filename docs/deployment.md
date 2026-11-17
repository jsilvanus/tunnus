# Deployment

This guide is for running Tunnus in production. For the settings themselves see
[`.env.example`](../.env.example); for the design see [`plan.md`](plan.md) and
[`production.md`](production.md).

## Image and tags

The image is published to the GitHub Container Registry as
`ghcr.io/<owner>/<repo>` by the `publish-image` workflow.

- A push to `main` publishes `main` and `sha-<short commit>`; it never moves `latest`.
- A manual run publishes `sha-<short commit>`, plus the extra tag and `latest`
  when the inputs ask for them.
- Pushing a git tag `v*` publishes the image too. Tag `v1.2.3` publishes
  `1.2.3`, `1.2` and `sha-<short commit>`, and moves `latest` only for tags
  without a pre-release suffix. `v1.2.3-rc.1` publishes `1.2.3-rc.1` and
  `sha-<short commit>` only.

Pin a version tag in production (`1.2.3`), not `latest`. The image runs as the
unprivileged `node` user, listens on `PORT` (default 3000) and has a container
health check that calls `/health`.

## Deployment workflow

The `publish-image` workflow (`.github/workflows/publish-image.yml`) runs on:

- a push to `main`: builds and pushes `main` and `sha-<short commit>`. It never
  moves `latest`.
- a push of a version tag `v*`: publishes the tags listed above, then calls the
  deploy webhook.
- a manual run (`workflow_dispatch`): publishes `sha-<short commit>` plus the
  optional inputs. It does not call the deploy webhook.

Every build records provenance and an SBOM attestation, and uses the GitHub
Actions build cache. Runs for one ref are serialised; a newer push to `main`
cancels a build still in progress for an older commit, while tag builds are
never cancelled.

The `deploy` job runs after a successful publish, only for pushes to `main` and
version tags. It does nothing unless two repository secrets are set:

| Secret                 | Notes                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `DEPLOY_WEBHOOK_URL`   | The URL to POST to. Empty or missing means no deploy step runs; the job is skipped without failing. |
| `DEPLOY_WEBHOOK_TOKEN` | Optional. When set, it is sent as `Authorization: Bearer <token>`. Never printed to the log.        |

The job POSTs a JSON body with `curl --fail --max-time 30`, so a non-2xx answer
fails the run:

```json
{
  "image": "ghcr.io/<owner>/<repo>",
  "tag": "sha-1a2b3c4",
  "sha": "1a2b3c4d5e6f...",
  "ref": "refs/heads/main"
}
```

For a version tag, `tag` is the tag name (`v1.2.3`) and `ref` is `refs/tags/v1.2.3`.
The receiver decides what to deploy; nothing in this repository names a target.

## Sign-in limits

Code issuance is limited per address per hour (`RATE_LIMIT_EMAIL_PER_HOUR`), per
IP per hour (`RATE_LIMIT_IP_PER_HOUR`) and per day (`MAIL_DAILY_CAP`). Sign-up
codes stop at the daily cap; login codes for existing users continue to 1.5 times
the cap, so a flood of sign-up requests cannot stop existing users from signing
in. An address is also locked for an hour after 10 failed code attempts in the
last hour, across all its sign-in pages. The checks and inserts run under
advisory locks, so concurrent requests cannot exceed a limit. See
[`security.md`](security.md) for the threat model.

## Required settings and secrets

| Setting                                                                    | Notes                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISSUER`                                                                   | Public URL of the provider, for example `https://id.example.org` or `https://example.org/id`. No trailing slash. Every route lives under its path.                                         |
| `DATABASE_URL`                                                             | PostgreSQL 16 connection string.                                                                                                                                                           |
| `KEY_ENCRYPTION_SECRET`                                                    | Encrypts the signing keys at rest. Keep it stable. Changing it makes the stored keys unreadable. Store it in a secret manager. At least 32 characters; the example placeholder is refused. |
| `COOKIE_SECRETS`                                                           | Comma-separated cookie signing keys, newest first. Each item at least 16 characters; items starting with `change-me` are refused.                                                          |
| `CLIENTS_FILE`                                                             | JSON file with the registered clients. `${NAME}` values are read from the environment, so client secrets stay out of the file.                                                             |
| `MAIL_PROVIDER`, `MAIL_FROM`, `SMTP_URL` or `BREVO_API_KEY`                | Sign-in codes are sent by mail. `console` is for development only: it logs the codes. With an https `ISSUER` it is refused unless `ALLOW_CONSOLE_MAIL=true`.                               |
| `ALLOW_CONSOLE_MAIL`                                                       | Set to `true` only to allow `MAIL_PROVIDER=console` (or unset) with an https `ISSUER`, for a non-production test instance.                                                                 |
| `DB_POOL_MAX`                                                              | Maximum database connections per process (default `10`). Idle connection errors are logged, not fatal.                                                                                     |
| `TRUST_PROXY`                                                              | Set it to the number of proxies in front of Tunnus (for example `1`), so client IP addresses are right for rate limits and audit.                                                          |
| `CONTROLLER_NAME`, `CONTROLLER_CONTACT`, `PROCESSORS` or `PROCESSORS_FILE` | Shown in the privacy notice and mail footers. See [Privacy notice](#privacy-notice).                                                                                                       |

### Rotating cookie secrets

Add the new secret at the front of `COOKIE_SECRETS` and keep the old one after
it. Restart, and once sessions signed with the old secret have expired (after
`SESSION_TTL_DAYS`, 14 by default), remove it.

## Database

Tunnus needs one PostgreSQL 16 database. It can have its own database or use
its own schema in a shared server. Give it its own role that owns the schema.

- Migrations run when Tunnus starts. They are forward-only and idempotent.
- Back up the database with `pg_dump` on a schedule. Tunnus keeps no other
  state.
- Test a restore regularly: restore a dump into a scratch database and start
  Tunnus against it.

## Reverse proxy

Tunnus is served through a reverse proxy with TLS. A path prefix in `ISSUER` is
passed through unchanged: the proxy must not strip it. A minimal nginx location
for `ISSUER=https://example.org/id`:

```nginx
location /id/ {
    proxy_pass http://127.0.0.1:3000;   # no URI part: the path is passed unchanged
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Tunnus sends `Strict-Transport-Security` itself when `ISSUER` is `https`, so
the proxy does not need to add it. Set `TRUST_PROXY` as described above, or the
rate limits see the proxy's address instead of the user's.

Do not expose `/admin/api/v1` and `/metrics` more widely than needed. The
admin API needs an admin token; `/metrics` needs its bearer token.

## First admin

Create the first administrator inside the container. The command runs
migrations, creates the user (or promotes an existing one) and prints an admin
token once on stdout. Store the token at once; it is not shown again.

```bash
docker compose exec app node bin/tunnus-admin.js bootstrap --email admin@example.org
```

## Health and metrics

### Health

`GET <issuer>/health` needs no authentication and is never cached.

```json
{ "status": "ok", "version": "0.1.0", "checks": { "database": "ok", "signing_key": "ok" } }
```

- `status` is `ok` or `fail`. `checks.database` is `ok` or `fail` (a `SELECT 1`
  with a 2 s timeout). `checks.signing_key` is `ok` when an active key exists,
  `missing` when none does, and `fail` when the query fails.
- The response is `200` when both checks pass and `503` otherwise.
- The body carries no error messages, hostnames or counts.

### Metrics

`GET <issuer>/metrics` is off (404) while `METRICS_BEARER_TOKEN` is empty. When it
is set, requests need `Authorization: Bearer <token>`; anything else gets `401`.

Metrics are in a private registry, prefixed `tunnus_`:

| Metric                                          | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `tunnus_sign_ins_total`                         | Sign-ins                                                                |
| `tunnus_sign_ups_total`                         | Accounts created by self-registration                                   |
| `tunnus_code_failures_total`                    | Wrong or expired sign-in codes                                          |
| `tunnus_mail_errors_total`                      | Failed mail sends                                                       |
| `tunnus_rate_limit_hits_total{reason}`          | Rate-limit hits; `reason` is `email`, `ip`, `daily` or `other`          |
| `tunnus_admin_auth_failures_total`              | Failed admin API authentications                                        |
| `tunnus_admin_requests_total`                   | Other admin API requests                                                |
| `tunnus_users_deleted_inactive_total`           | Accounts deleted for inactivity                                         |
| `tunnus_inactive_warnings_sent_total`           | Inactivity warnings sent                                                |
| `tunnus_users{status}`                          | Users by status (gauge)                                                 |
| `tunnus_signing_key_age_seconds`                | Age of the active signing key (gauge)                                   |
| `tunnus_cleanup_last_success_timestamp_seconds` | Time of the last complete cleanup run; `0` before the first run (gauge) |

Counters are per process. With several replicas, Prometheus sums them.

Scrape configuration, with the same token as `METRICS_BEARER_TOKEN`:

```yaml
scrape_configs:
  - job_name: tunnus
    metrics_path: /id/metrics # <issuer path>/metrics
    authorization:
      type: Bearer
      credentials: <METRICS_BEARER_TOKEN>
    static_configs:
      - targets: ['tunnus:3000']
```

Suggested alerts:

- `/health` returns anything but `200` for several minutes.
- `tunnus_signing_key_age_seconds` is older than the rotation schedule (for
  example 90 days plus a margin).
- The cleanup job is stale: `time() - tunnus_cleanup_last_success_timestamp_seconds`
  exceeds two intervals. Do not alert on this when cleanup is disabled
  (`CLEANUP_DISABLED=true`), because the gauge then stays at `0`.
- A rise in `tunnus_mail_errors_total` or `tunnus_admin_auth_failures_total`.

## Cleanup

Cleanup removes data that is no longer needed. It runs in one of two ways.

- **In-process (default).** The first run starts `CLEANUP_START_DELAY_SECONDS`
  after start (default 60), plus up to 60 s of random jitter. Runs repeat every
  `CLEANUP_INTERVAL_HOURS` (default 24, minimum 1).
- **External.** Set `CLEANUP_DISABLED=true` and run `tunnus-admin cleanup` from
  cron, for example daily:

  ```bash
  docker compose exec app node bin/tunnus-admin.js cleanup
  ```

  It runs migrations first, runs all tasks once and prints the counts as JSON on
  stdout. It exits `1` when a task failed (the JSON is still printed), `0` otherwise,
  including when another run holds the lock (`{ "skipped": true }`).

With several replicas, only one run proceeds at a time: each run takes a
PostgreSQL advisory lock, and a run that cannot get it is skipped.

Tasks run in this order. Each is independent: a failing task is logged and the
others still run. Deletes and updates run in batches of 1 000 rows.

1. Delete expired sign-in payloads.
2. Delete sign-in codes that expired more than a day ago.
3. Remove IP addresses from audit rows older than `AUDIT_IP_RETENTION_DAYS`
   (default 30).
4. Delete audit rows older than `AUDIT_RETENTION_DAYS` (default 365).
5. Send inactivity warnings.
6. Delete inactive accounts.

Inactivity is measured from the last sign-in, or from creation for accounts that
never signed in. Administrators are never warned or deleted automatically. A
warning is sent `INACTIVE_USER_WARN_DAYS` (default 30) before deletion, and
signing in cancels it. Deletion happens after `INACTIVE_USER_DELETE_DAYS`
(default 730) without a sign-in.

Warnings are capped at `MAIL_DAILY_CAP` per run. They are not counted against the
sign-in code limit, which counts only sign-in codes. Each warning is sent in the
default locale, with the deletion date in UTC (`YYYY-MM-DD`).

Setting `INACTIVE_USER_DELETE_DAYS=0` turns off warnings and deletion. Setting
`AUDIT_RETENTION_DAYS=0` or `AUDIT_IP_RETENTION_DAYS=0` turns off that audit
task. Zero never means "delete everything".

Each run is audited as `cleanup.run` with the counts. A run in which no task failed
updates `tunnus_cleanup_last_success_timestamp_seconds`. A mail that fails to send is
retried by the next run and does not count as a failed task.

## Privacy notice

`<issuer>/privacy` serves the privacy notice, built from the settings: controller,
data protection officer, what is stored, why, retention and processors. The
language follows `?lang=fi|sv|en`, then `Accept-Language`, then `DEFAULT_LOCALE`.

- Set `PRIVACY_NOTICE_URL` to point the footer and `/privacy` at a notice you host
  elsewhere. `/privacy` then redirects there with `302`.
- `PROCESSORS` is a JSON list of `{ "name", "purpose", "location" }` objects. Put
  the same list in a file and set `PROCESSORS_FILE` to its path instead. Set one
  of them, not both. Invalid JSON or a wrong shape stops Tunnus at startup, and
  the error names the variable.
- If you do not use the built-in page, adapt
  [`privacy-notice-template.md`](privacy-notice-template.md).

## Upgrades

1. Back up the database.
2. Pull the new image tag and restart. Migrations run at start.
3. Check `/health`.

Migrations are forward-only, so a rollback to an older image may not start
against a migrated database. Restore the backup if you need to go back.

## Key rotation

Signing keys should be rotated on a schedule, for example every 90 days, with
the `tunnus` admin CLI (it needs `TUNNUS_URL` and `TUNNUS_ADMIN_TOKEN`, see the
[README](../README.md)):

```bash
tunnus keys rotate
```

Rotation promotes the `next` key to `active`, creates a new `next` key, and keeps
the old key published in JWKS for `KEY_RETIRED_GRACE_DAYS` (default 7). Clients
that cache JWKS keep accepting tokens signed with it during that time.

If a key may have leaked, retire it with `tunnus keys retire <kid>`. A retired
key stays published until its grace period ends, so shorten
`KEY_RETIRED_GRACE_DAYS` while you respond to the incident, and rotate so that
the active key is a new one.

## Outage

While Tunnus is down, no one can sign in to the clients that use it. Clients
should keep a local break-glass login for their own administrators, so they can
still get in to fix things.

## Related

- [`plan.md`](plan.md): design and architecture.
- [`production.md`](production.md): decisions behind this guide.
- [`conformance.md`](conformance.md): running the OpenID conformance suite.
