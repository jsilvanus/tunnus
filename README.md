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

## Licence

[EUPL-1.2](LICENSE).
