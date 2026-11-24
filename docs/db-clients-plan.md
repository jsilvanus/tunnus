# Plan: OIDC clients in the database

Status: implemented. Replaces the "Clients managed in the database
through the admin API" item under "Later" in [TODO.md](TODO.md) and answers
the open question in [plan.md](plan.md).

## Goal

Today every client comes from `CLIENTS_FILE`. Adding or changing a client
means editing that file, setting its `${NAME}` secret in the environment and
restarting Tunnus. After this change:

- Clients live in a database table and are created, changed, rotated and
  deleted through the admin API, the `tunnus` CLI, the MCP server, or the
  local `tunnus-admin` command. No restart is needed.
- `CLIENTS_FILE` keeps working, as a seed. Existing deployments and fresh
  installs behave exactly as before until someone starts using the API.
- Client secrets are encrypted at rest and never returned after creation.

Non-goals: open dynamic client registration (RFC 7591) for anonymous callers,
an admin web UI, and two valid secrets at the same time (see Rotation).

## Design choices

### Static clients rebuilt from the database, not `adapter('Client')`

`oidc-provider` can look up clients it does not know through the storage
adapter (`Client` model). We do not use that route:

- `createResourceServerInfoResolver`, `alwaysGroupsOf` and the account page's
  app list all need the _whole_ client list, not one client by id.
- `providerHolder` already rebuilds the provider when the signing key set
  changes. Clients become a second reason to rebuild, with the same swap-only-
  when-it-succeeds behaviour.
- Adapter-loaded clients would mix with `CLIENTS_FILE` static clients in two
  different caches, which makes "which definition wins" hard to reason about.

So the holder loads all enabled rows from `oidc_clients`, decrypts their
secrets, and passes them to `createProvider` as the `clients` array, exactly
the shape `loadClients` returns today. The `Client` adapter model stays unused.

### Secrets are encrypted, not hashed

`oidc-provider` compares the presented secret with `client_secret` in plain
form (`client_secret_basic`/`_post`), and would use it as the HMAC key for
`client_secret_jwt` or HS256 ID tokens. A hash cannot do either. So the secret
is stored with AES-256-GCM (`encryptWithKey`) under a subkey derived from the
existing `KEY_ENCRYPTION_SECRET`: `deriveSubkey(secret, 'client-secret')`,
the same pattern as TOTP secrets. **No new deployment secret.**

The plaintext exists only in process memory (inside the provider) and in the
one API/CLI response that creates or rotates it.

### Where a client's definition comes from

Each row has `source`:

| source | Written by                          | Admin API may change it                           |
| ------ | ----------------------------------- | ------------------------------------------------- |
| `file` | startup sync from `CLIENTS_FILE`    | No (409 `client_managed_by_file`), except `adopt` |
| `api`  | admin API, CLI, MCP, `tunnus-admin` | Yes                                               |

Startup sync, run after migrations on every start:

1. For each entry in `CLIENTS_FILE` (`${NAME}` substitution as today):
   - no row: insert with `source = 'file'`;
   - row with `source = 'file'`: overwrite metadata and secret (the file is
     authoritative for its own clients, so editing the file still works);
   - row with `source = 'api'`: skip and log a warning. The database wins.
2. Rows with `source = 'file'` whose id is no longer in the file are
   **disabled**, not deleted, and logged. An operator deletes them through the
   API when sure. (Deleting revokes tokens; that should not happen because a
   line was removed from a file.)
3. A file entry that used a `${NAME:-default}` fallback stays `disabled`, as
   today.

`adopt` (`POST /clients/{id}/adopt`) flips a `file` row to `api`. After that
the entry can be removed from `CLIENTS_FILE` and is then managed only through
the API. This is the migration path for existing clients.

With `CLIENTS_FILE` empty or unset and no rows, Tunnus starts with no clients,
as today.

## Database changes

New migration `009_clients.sql`:

```sql
CREATE TABLE IF NOT EXISTS oidc_clients (
  client_id text PRIMARY KEY
    CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  metadata jsonb NOT NULL,          -- non-secret oidc-provider metadata, allowlisted keys
  secret_enc text,                  -- AES-256-GCM, NULL for public clients (auth method none)
  secret_set_at timestamptz,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('file', 'api')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- One counter, bumped in the same transaction as any change to oidc_clients
-- (including deletes), so a reload check is one cheap query.
CREATE TABLE IF NOT EXISTS oidc_client_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO oidc_client_state (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Deleting a client or rotating with revoke removes its grants and tokens.
CREATE INDEX IF NOT EXISTS oidc_payloads_client_idx ON oidc_payloads ((payload->>'clientId'));
```

`metadata` holds the keys `loadClients` passes through today, allowlisted:
`redirect_uris`, `post_logout_redirect_uris`, `token_endpoint_auth_method`,
`grant_types`, `response_types`, `first_party`, `always_include_groups`,
`allowed_resources`, `backchannel_logout_uri`,
`backchannel_logout_session_required`, `id_token_signed_response_alg`,
`client_name`. Anything else is rejected with 400, so a typo cannot silently
do nothing. `client_secret` is never in `metadata`.

A jsonb column instead of one column per field keeps the table stable as
`oidc-provider` metadata grows; the allowlist and the OpenAPI schema are the
contract.

## Loading, cache and invalidation

- `providerHolder.reload()` reads the key set **and** all non-disabled
  clients, builds the provider, then swaps. If one row fails
  `oidc-provider` validation it is skipped and logged
  (`client.invalid`, error level, plus a metric), so one bad row can never
  stop the provider from starting.
- Writes through the admin API call `holder.reload()` before responding, so
  the change is live in that process when the call returns.
- Writes from another process (`tunnus-admin` run with `docker compose exec`,
  or a second instance) are picked up by the existing periodic check: the
  holder already polls `publishedKids` every `KEY_RELOAD_INTERVAL_SECONDS`
  (default 60). It now also reads `oidc_client_state.version` and rebuilds
  when either changed. In addition, writers run `NOTIFY tunnus_clients` and
  the server `LISTEN`s on a dedicated connection to reload at once; the poll
  stays as the fallback when the listener is down.
- Rebuilding the provider loses no state: sessions, grants and tokens are in
  `oidc_payloads`.

## Validation before a write

Before inserting or updating, the handler validates the candidate metadata
with `oidc-provider` itself (`provider.Client.validate(...)` on the current
provider; confirm the exact static method name for the installed major
version during implementation, and fall back to building a throwaway
`Provider` with only that client). Plus our own rules:

- every `redirect_uris` / `post_logout_redirect_uris` /
  `backchannel_logout_uri` entry is an absolute URL; `https` required except
  `http://localhost` and `http://127.0.0.1`;
- `token_endpoint_auth_method` in `client_secret_basic`, `client_secret_post`,
  `none` (none only with PKCE, which is already required);
- confidential clients must have a secret; generated secrets are 32 random
  bytes, base64url; supplied secrets must be at least 32 characters.

## Admin API

All under the existing bearer-token admin auth. New operations in
`openapi.yaml` (the CLI and MCP tools are generated from it):

| Method   | Path                   | CLI                     | Notes                                                                                                                                                                                                                                                       |
| -------- | ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/clients`             | `clients list`          | Existing; now from the table; adds `source`, `disabled`, `secret_set_at`, timestamps                                                                                                                                                                        |
| `GET`    | `/clients/{id}`        | `clients get`           | Never returns the secret                                                                                                                                                                                                                                    |
| `PUT`    | `/clients/{id}`        | `clients put`           | Create or replace metadata. Idempotent, so provisioning scripts can re-run it. Body may carry `client_secret`; if creating without one, a secret is generated and returned **once** (201). Replacing without `client_secret` keeps the current secret (200) |
| `PATCH`  | `/clients/{id}`        | `clients update`        | Partial metadata change, `disabled` toggle                                                                                                                                                                                                                  |
| `POST`   | `/clients/{id}/secret` | `clients rotate-secret` | Sets the given secret or generates one (returned once). Option `revoke_tokens` (default false) also deletes the client's refresh tokens and grants                                                                                                          |
| `POST`   | `/clients/{id}/adopt`  | `clients adopt`         | `file` → `api`                                                                                                                                                                                                                                              |
| `DELETE` | `/clients/{id}`        | `clients delete`        | Deletes the row and all `oidc_payloads` with that `clientId` (grants, refresh and access tokens, codes)                                                                                                                                                     |

Errors: 404 unknown client, 409 `client_managed_by_file`, 400 validation
with the failing field. The MCP server treats every client mutation like
other mutations (commit list / fixed-time window).

Audit events (no secret, ever): `client.created`, `client.updated`,
`client.secret_rotated`, `client.adopted`, `client.disabled`,
`client.deleted`, `client.synced_from_file`. Details hold the changed field
names, not values, for redirect-URI changes the old and new URI lists.

Metrics: `tunnus_clients{source,disabled}` gauge, `tunnus_client_reloads_total`,
`tunnus_client_invalid_total`.

## Local command for provisioning without a token

`tunnus-admin` gains a `clients` group that talks to the database directly
(like `bootstrap`), for automation that already has shell access to the host:

```
tunnus-admin clients put <client_id> --metadata-file <path|->
                         [--secret-env <VAR>] [--generate-secret]
tunnus-admin clients rotate-secret <client_id> [--secret-env <VAR>] [--generate-secret] [--revoke-tokens]
tunnus-admin clients delete <client_id>
tunnus-admin clients list
```

- The secret is read from the named environment variable, never from argv
  (argv is visible in `ps` and shell history). A generated secret is printed
  on stdout only.
- Same validation and audit as the API, with `actor_user_id = NULL` and
  `details.via = 'tunnus-admin'`.
- Runs `NOTIFY tunnus_clients` after commit, so the server reloads at once.

This lets a deployment provision clients with
`docker compose exec -T -e CLIENT_SECRET tunnus node bin/tunnus-admin.js clients put ...`
and needs **no admin API token** in CI.

## Rotation

`oidc-provider` holds one `client_secret` per client, so there is no overlap
window in this version. The rotation order that avoids a gap:

1. Store the new secret wherever the relying party reads it, without
   restarting the relying party yet.
2. `rotate-secret` in Tunnus (live within a second via NOTIFY).
3. Restart/redeploy the relying party.

Between 2 and 3, only the relying party's back-channel calls (code exchange,
refresh) fail; signed-in users keep their sessions in the relying party. If a
real overlap is needed later, add `previous_secret_enc` +
`previous_secret_expires_at` and a custom client-authentication hook; out of
scope here.

`KEY_ENCRYPTION_SECRET` rotation: client secrets follow whatever re-encryption
mechanism signing keys and TOTP secrets get; no separate procedure.

## Code changes (for the implementer)

1. `migrations/009_clients.sql` as above.
2. `src/clients/store.js` (new): `listClients(pool, secret)`, `getClient`,
   `putClient`, `patchClient`, `rotateSecret`, `adoptClient`, `deleteClient`,
   `syncFromFile(pool, fileClients, secret, logger)`. Every write in one
   transaction that also bumps `oidc_client_state.version` and runs
   `NOTIFY tunnus_clients`. Encryption via `deriveSubkey(KEY_ENCRYPTION_SECRET,
'client-secret')`.
3. `src/clients/validate.js` (new): allowlist, URL rules, `oidc-provider`
   validation.
4. `src/server.js`: after `migrate`, run `syncFromFile` with
   `loadClients(config.clientsFile)`; stop passing a static `clients` array.
5. `src/oidc/providerHolder.js`: `reload()` loads clients from the store;
   `checkForChanges()` also compares the client version; add `LISTEN`.
   Expose `holder.clients` (current list) for the resolver, admin handlers
   and account page.
6. `src/oidc/provider.js`, `src/web/account.js`, `src/admin/router.js`,
   `src/admin/types.js`: take the client list from the holder instead of the
   startup array (it now changes at runtime).
7. `src/admin/handlers/clients.js`, `openapi.yaml`, `src/admin/spec.js`: new
   operations; `clientJson` adds `source`, `disabled`, `secret_set_at`,
   `created_at`, `updated_at`.
8. `bin/tunnus-admin.js`: `clients` subcommands.
9. MCP: new tools come from the spec; mark all client mutations as mutative.
10. Tests: store unit tests (encrypt round trip, version bump, file sync
    rules incl. `api` row wins and removed-file-entry disables), integration
    tests for each API operation, a flow test that creates a client through
    the API and signs in with it **without restarting**, a test that a
    deleted client's refresh token stops working, a test that one invalid row
    does not stop the provider, and `tunnus-admin clients put` + NOTIFY reload.
11. Docs: `admin-api.md`, `cli-mcp.md`, `deployment.md` (CLIENTS_FILE is now
    a seed; provisioning with `tunnus-admin`), `security.md` (secret storage),
    `TODO.md` (tick the item), `clients.example.json` unchanged.

Suggested split for implementation: (A) migration + store + file sync +
holder reload (no API yet; behaviour identical to today), (B) admin API +
OpenAPI + CLI/MCP, (C) `tunnus-admin clients`. A must land first; B and C can
run in parallel after it.

## Rollout for an existing deployment

1. Deploy the version with A. On start every `CLIENTS_FILE` entry is inserted
   as `source = 'file'`. Nothing else changes; sign-ins continue.
2. Deploy B and C. New clients are created with the API or `tunnus-admin`;
   no restart.
3. For each existing client, when convenient: `clients adopt <id>`, then
   remove it from `CLIENTS_FILE` (and its `${NAME}` variable from the
   environment) in a later, unhurried deploy.
4. When the file is empty, `CLIENTS_FILE` can be unset.

Rollback: the previous image ignores `oidc_clients` and reads
`CLIENTS_FILE`, so keep every client in the file until step 3 has been done
for it. A client created only through the API does not exist in an older
image.
