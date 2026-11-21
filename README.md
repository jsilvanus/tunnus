# Tunnus

A small, self-hosted OpenID Connect provider. Users sign in with a one-time
code sent to their email address; there are no passwords. Tunnus gives each
user a stable `sub`, a verified `email`, a display `name` and a `groups` claim.

Status: early development. See [`docs/plan.md`](docs/plan.md) for the design
and [`docs/TODO.md`](docs/TODO.md) for the roadmap.

## Quick start

```bash
nvm use                 # Node 24
npm install
docker compose up -d    # PostgreSQL 16
cp .env.example .env
npm test
```

## Configuration

Every setting is an environment variable; see [`.env.example`](.env.example).
Nothing deployment-specific (domains, groups, clients, branding, controller
details) is built into the code.

Clients are described in a JSON file (`CLIENTS_FILE`). A client that wants refresh
tokens needs `"grant_types": ["authorization_code", "refresh_token"]`; its requests
need `offline_access` and `prompt=consent`. See the clients section of
[`docs/deployment.md`](docs/deployment.md).

Security notes and the threat model are in [`docs/security.md`](docs/security.md).

Running Tunnus in production (image, database, reverse proxy, keys, cleanup,
backups) is described in [`docs/deployment.md`](docs/deployment.md).

Operational endpoints under the issuer path:

- `GET <issuer>/health`: database and signing-key status, no authentication.
- `GET <issuer>/metrics`: Prometheus metrics, only when `METRICS_BEARER_TOKEN`
  is set; requires `Authorization: Bearer <token>`.
- `GET <issuer>/privacy`: the privacy notice, built from the controller and
  processor settings (or a redirect to `PRIVACY_NOTICE_URL`).
- `POST <issuer>/api/mail`: transactional mail relay for relying parties, only
  when `MAIL_RELAY_TOKEN` is set; requires `Authorization: Bearer <token>`.

## Administration

The first admin is created inside the container. The command runs migrations,
creates the user (or promotes an existing one), and prints an admin token once
on stdout. Store it at once; it is not shown again.

```bash
docker compose exec app node bin/tunnus-admin.js bootstrap --email admin@example.org
```

The admin API is at `<issuer>/admin/api/v1`. Its contract is
[`openapi.yaml`](openapi.yaml), also served at `<issuer>/admin/api/v1/openapi.yaml`.
Every call needs an admin token:

```bash
curl -H "Authorization: Bearer tun_..." https://id.example.org/admin/api/v1/me
```

### The `tunnus` command

`tunnus` is a command-line client for the admin API. It reads the contract at
run time, so every operation in `openapi.yaml` is a command (`tunnus --help`
lists them; `tunnus users create --help` shows the flags). The URL and token
come from `TUNNUS_URL` and `TUNNUS_ADMIN_TOKEN`, from `--url` and
`--token-file`, or from a config file, `~/.config/tunnus/config.json`
(or `$XDG_CONFIG_HOME/tunnus/config.json`, or the file named by `--config` or
`TUNNUS_CONFIG`):

```json
{ "url": "https://id.example.org", "token": "tun_..." }
```

Keep that file readable only by you (`chmod 600`); `tunnus` warns when it is not.

```bash
tunnus whoami
tunnus users list --q ada --json
tunnus users create --email ada@example.org --display-name "Ada"
tunnus groups grant 3 6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11
tunnus users delete 6f1b1d0e-3c1e-4c7a-9a52-2f0f5a3c9b11 --yes
```

Lists print a table by default and `--json` prints the response. `--all`
follows the pages. Destructive commands ask you to type `yes`; without a
terminal they need `--yes`.

### The `tunnus-mcp` server

`tunnus-mcp` exposes the same operations as tools for AI agents. Over stdio
(the default) it uses the token from the same configuration as `tunnus`:

```bash
tunnus-mcp
```

With `--http` it serves Streamable HTTP at `POST /mcp` on `MCP_HOST`
(default `127.0.0.1`) and `MCP_PORT` (default `8090`). It stores no token:
every request carries its own `Authorization: Bearer tun_...`, which goes
straight to the admin API. Put it behind TLS if it is reachable from elsewhere.

```bash
tunnus-mcp --http
```

Mutative operations in MCP are guarded: by default they are disabled until the
CLI allows them into a reviewable commit list (`tunnus mcp allow commit-list`) or
for a 15-minute window (`tunnus mcp allow 15m`). Staged actions in the commit
list can be executed from the CLI (`tunnus mcp commit`) or by MCP via
`executeCommitList` while the 15-minute window is active. Admin token management
remains CLI-only so sensitive tokens never enter an AI context.

## Licence

[EUPL-1.2](LICENSE).
