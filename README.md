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

## Licence

[EUPL-1.2](LICENSE).
