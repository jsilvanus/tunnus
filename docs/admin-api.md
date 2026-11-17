# Admin API: design and implementation notes

Phase 3 of [`TODO.md`](TODO.md). The contract is [`../openapi.yaml`](../openapi.yaml);
this document records the decisions behind it and the internal structure
the code follows. Where they differ, `openapi.yaml` wins for the wire
format and this document wins for behaviour the spec cannot express.

## Decisions

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Mount point            | `<issuer>/admin/api/v1`, mounted in the issuer router before `provider.callback()`                                                                                                                                                                                                                                                                                                                                                | Same path-prefix rule as the rest of Tunnus                                                       |
| Spec                   | OpenAPI 3.1 (`openapi.yaml` at the repo root), JSON Schema 2020-12                                                                                                                                                                                                                                                                                                                                                                | Phase 4 generates the CLI and MCP server from it                                                  |
| Routing                | Routes are registered **from the spec**: one route per `operationId`, mapped to a handler of the same name. Startup fails if an operation has no handler or a handler has no operation                                                                                                                                                                                                                                            | The API cannot drift from the spec                                                                |
| Validation             | Ajv 8 (`ajv/dist/2020.js`) + `ajv-formats`; spec parsed with `yaml`. Path and query parameters are coerced to their schema types; unknown query parameters and unknown body properties are rejected; defaults from the spec are applied                                                                                                                                                                                           | Small, well-known, no framework lock-in                                                           |
| Response validation    | On when the app is built with `validateResponses: true` (tests always) or `ADMIN_VALIDATE_RESPONSES=true`. A mismatch is logged and returned as `500 internal`                                                                                                                                                                                                                                                                    | Catches spec drift in CI without costing production                                               |
| Errors                 | `{ "error": { "code", "message", "details"? } }`; codes listed in the `Error` schema. Validation errors list `{ path, message }` details                                                                                                                                                                                                                                                                                          | One shape for CLI and MCP to render                                                               |
| Paging                 | `limit` (1–200, default 50) and an opaque `cursor`; responses carry `next_cursor` (null on the last page). Cursor is base64url JSON of the last row's sort key                                                                                                                                                                                                                                                                    | Stable under inserts, no `OFFSET` scans                                                           |
| Sort orders            | users and members by email, groups by name, audit events by id descending, keys newest first                                                                                                                                                                                                                                                                                                                                      | Predictable CLI output                                                                            |
| Ids                    | Users and tokens by UUID, groups by integer id. Group names contain `/`, so they are not used in paths; `GET /groups?name=` finds one by name                                                                                                                                                                                                                                                                                     | Avoids encoded slashes in paths                                                                   |
| Admin tokens           | `tun_` + 32 random bytes base64url (43 chars). Stored as SHA-256 hex in `admin_tokens.token_hash` (unique). Default lifetime 90 days, maximum 365                                                                                                                                                                                                                                                                                 | A recognisable prefix helps secret scanners; the token is high-entropy, so a plain hash is enough |
| Token validity         | Not revoked, not expired, user `active` and `is_admin`. Checked on every request; `last_used_at` updated at most once a minute                                                                                                                                                                                                                                                                                                    | Disabling or demoting a user cuts off their tokens immediately                                    |
| Failed auth            | `401 unauthorized` with `WWW-Authenticate: Bearer`; audited as `admin.auth_failed` with a reason (`missing`, `malformed`, `unknown`, `expired`, `revoked`, `not_admin`, `disabled`). More than 20 failures from one IP in 10 minutes gives `429 rate_limited` (in memory, not audited)                                                                                                                                            | Visible brute-force attempts without unbounded audit growth                                       |
| Auditing               | Every authenticated call is audited, reads included: action `admin.<operationId>`, actor = the token's user, `details.status` = HTTP status, plus handler details. Written before the response is sent                                                                                                                                                                                                                            | The plan requires every admin call to be audited; admin traffic is low                            |
| Personal data in audit | Never email addresses or display names in `details`; for user changes record the changed field **names** (`details.fields`) and status/admin flags. Group names and key ids are fine                                                                                                                                                                                                                                              | Plan: audit rows keep only the `sub`                                                              |
| Session revocation     | `revokeUserSessions(pool, userId)`: `DELETE FROM oidc_payloads WHERE payload->>'accountId' = $1`. This removes sessions, grants, authorization codes, access and refresh tokens. Indexed by an expression index                                                                                                                                                                                                                   | Every oidc-provider model tied to a user carries `accountId` at the top level                     |
| Disable                | `status: disabled` → revoke sessions, set `revoked_at` on the user's admin tokens. `findAccount` already refuses disabled users                                                                                                                                                                                                                                                                                                   | Plan: disabling ends sessions and revokes refresh tokens                                          |
| Delete                 | Revoke sessions, then delete the user (memberships and admin tokens cascade). Audit rows keep the user id                                                                                                                                                                                                                                                                                                                         |                                                                                                   |
| Last admin             | Any change that would leave zero active admins (disable, demote, delete) fails with `409 last_admin`                                                                                                                                                                                                                                                                                                                              | Prevents lock-out; `tunnus-admin bootstrap` is the recovery path                                  |
| Default groups         | `DEFAULT_GROUPS` are created at start (`ensureDefaultGroups`). `is_default` is derived from configuration, not stored. They cannot be deleted or renamed (`409 default_group`); members can be removed                                                                                                                                                                                                                            | Renaming would silently break the next start                                                      |
| Group changes          | Take effect in the `groups` claim at the next token refresh, userinfo call or sign-in; no session revocation                                                                                                                                                                                                                                                                                                                      | Same as any claim change                                                                          |
| Keys                   | One `active`, one `next`, and `retired` keys published until `published_until`. Grace `KEY_RETIRED_GRACE_DAYS`, default 7                                                                                                                                                                                                                                                                                                         | ID and access tokens live 10 minutes; 7 days covers long JWKS caches                              |
| Rotation               | In one transaction under `pg_advisory_xact_lock`: active → retired (`retired_at = now()`, `published_until = now() + grace`), next → active, create a new next. With no next key, create and promote one and warn `next_key_missing`                                                                                                                                                                                              | Matches the plan's one-active-one-next model                                                      |
| Retire                 | `retired` key: `published_until = now()`. `next` key: retire unpublished and create a new next. `active`: `409 key_active`                                                                                                                                                                                                                                                                                                        | Retire is the "remove from JWKS now" lever, for example after a leak                              |
| Applying key changes   | oidc-provider reads its keystore at construction, so the app keeps the provider in a holder and rebuilds it when the published key set changes: immediately after rotate or retire, and by polling every `KEY_RELOAD_INTERVAL_SECONDS` (default 60, `0` disables) so other replicas and grace expiry are picked up                                                                                                                | Keeps a single process correct at once and several replicas correct within a minute               |
| Signing key choice     | JWKS order is active, next, retired; oidc-provider signs with the first matching key, so the active key signs                                                                                                                                                                                                                                                                                                                     |                                                                                                   |
| Clients                | `GET /clients` lists the configured clients without secrets                                                                                                                                                                                                                                                                                                                                                                       | Read-only while clients live in a file                                                            |
| Spec served            | `GET <issuer>/admin/api/v1/openapi.yaml` returns the spec without auth (outside the spec's operations)                                                                                                                                                                                                                                                                                                                            | The phase 4 CLI can fetch it from the server it talks to                                          |
| Bootstrap              | `tunnus-admin bootstrap --email <addr> [--name] [--label] [--expires-days]` runs inside the container with `DATABASE_URL`. It runs migrations, creates the user or promotes an existing one (re-activating a disabled one), creates a token and prints it once on stdout. Allowed even when admins exist (it is the recovery path; anyone who can run it already has database access). Audited as `admin.bootstrap` with no actor | Plan: first admin created from inside the container                                               |

## Data model changes (migration `003_admin.sql`)

```sql
CREATE TABLE IF NOT EXISTS admin_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_tokens_user_idx ON admin_tokens (user_id);
ALTER TABLE signing_keys ADD COLUMN IF NOT EXISTS published_until timestamptz;
CREATE INDEX IF NOT EXISTS oidc_payloads_account_idx ON oidc_payloads ((payload->>'accountId'));
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_user_id, id);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_type, target_id, id);
```

## New configuration

| Variable                      | Default | Purpose                                                         |
| ----------------------------- | ------- | --------------------------------------------------------------- |
| `KEY_RETIRED_GRACE_DAYS`      | `7`     | How long a retired key stays in JWKS                            |
| `KEY_RELOAD_INTERVAL_SECONDS` | `60`    | How often to check for key changes made elsewhere; `0` disables |
| `ADMIN_VALIDATE_RESPONSES`    | `false` | Validate admin API responses against the spec                   |

## Code layout

```
openapi.yaml                 the contract
bin/tunnus-admin.js          bootstrap command
src/adminTokens.js           generateToken, hashToken, createAdminToken, findTokenByValue
src/admin/spec.js            load + parse openapi.yaml, list operations
src/admin/validate.js        Ajv setup, per-operation request/response validators
src/admin/router.js          createAdminRouter: auth, validation, handler, audit, errors
src/admin/auth.js            bearer-token middleware + failed-auth limiter
src/admin/errors.js          AdminError
src/admin/paging.js          encodeCursor, decodeCursor, clampLimit
src/admin/handlers/index.js  merges the handler modules below
src/admin/handlers/me.js       getMe, listAdminTokens, createAdminToken, revokeAdminToken
src/admin/handlers/users.js    users + revokeUserSessions
src/admin/handlers/groups.js   groups + memberships
src/admin/handlers/keys.js     listKeys, rotateKeys, retireKey
src/admin/handlers/audit.js    listAuditEvents
src/admin/handlers/clients.js  listClients
src/oidc/providerHolder.js   holds the current Provider, rebuilds it on key changes
```

### Handler contract

```js
/** @typedef {{
 *   req: import('express').Request,
 *   pool: import('pg').Pool,
 *   config: import('../config.js').Config,
 *   clients: Record<string, any>[],
 *   actor: { userId: string, tokenId: string },
 *   ip: string | null,
 *   params: Record<string, any>,   // validated and coerced
 *   query: Record<string, any>,    // validated, coerced, defaults applied
 *   body: any,                     // validated, defaults applied
 *   reloadKeys: () => Promise<void>,
 * }} HandlerContext */

/** @typedef {{
 *   status?: number,               // default 200; 204 sends no body
 *   body?: unknown,
 *   audit?: { targetType?: string, targetId?: string, details?: Record<string, unknown> },
 * }} HandlerResult */

// A handler: async (ctx) => HandlerResult. Throw new AdminError(status, code, message) for errors.
```

Timestamps are returned as ISO 8601 strings (`Date#toISOString()`); bigint ids as strings.
