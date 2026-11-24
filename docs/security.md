# Security notes and threat model

This note records what Tunnus protects, against whom, and what it deliberately
does not do. It goes with the code review of 2026-11-17 (see
[`reviews/2026-11-17-code-review.md`](reviews/2026-11-17-code-review.md)) and
the follow-up list in [`TODO.md`](TODO.md). Operational settings are in
[`deployment.md`](deployment.md).

## Who can do what

| Actor                            | Can                                                                                   | Limited by                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Anyone on the internet           | Ask for sign-in codes for any address; try codes and links; call the public endpoints | Per-address and per-IP limits, daily cap, failed-attempt lockout                                           |
| A person who owns an address     | Sign in as the account for that address                                               | Their mailbox; the code and link expire after 10 minutes                                                   |
| A relying party (client)         | Receive the claims of users who sign in to it; refresh and revoke its own tokens      | Client registration in `oidc_clients` (or `CLIENTS_FILE`); `first_party` and `always_include_groups` flags |
| An admin (`is_admin` user)       | Use the admin API: users, groups, memberships, keys, clients, audit, admin tokens     | Admin token authentication; audit log                                                                      |
| An operator with database access | Read everything in the database, including hashed tokens and encrypted codes          | Out of scope for the application; protect the database                                                     |
| An operator with the secrets     | Decrypt stored codes, derive any key                                                  | Out of scope; keep `KEY_ENCRYPTION_SECRET` and `COOKIE_SECRETS` safe                                       |

## Email verification and `email_verified` (L1)

- An address becomes a verified account only when its owner types the code or
  opens the link. Both are single use and expire after 10 minutes.
- Every ID token and userinfo response says `email_verified: true`, because
  every account exists only through that proof. There is no unverified account
  state to report.
- An admin can change a user's address through the admin API. The new address
  is **not** verified again: the claim stays `true` and the account is not asked
  to prove the new address. Admins must treat an address change as trusting the
  new address. Use a change only for an address the admin has checked by other
  means. Self-service change with verification is on the list for later
  (see [`TODO.md`](TODO.md), "Later").

## Admin tokens (L6)

- An admin token acts with the full power of its user's admin role. There are
  no read-only or scoped tokens.
- Any admin can mint a token for another admin: `POST /admin-tokens` takes an
  optional `user_id`. The created token is audited with the creating admin as
  the actor. This is deliberate for now, and it means a compromised admin
  account can grant itself persistence through another admin's identity.
- Tokens are hashed at rest. Their values are never listed or logged, and the
  MCP server does not expose token creation or revocation.
- Before tokens are handed to automation that should not be able to change
  everything, add scopes (for example read-only) and restrict who may mint
  tokens for whom.

## Sign-in codes: storage and lifetime (L14)

- A code is six digits from a CSPRNG. The database holds an HMAC of it with a
  subkey derived from `KEY_ENCRYPTION_SECRET` (purpose `email-code-hmac`), so a
  database copy alone does not reveal a code.
- The same row also holds an encrypted copy of the code (subkey
  `email-code-encrypt`). It is kept only to show the code on the link page, when
  the link is opened in another browser than the one that started sign-in.
  Anyone with the database and the secret can decrypt it.
- A six-digit space is small: with the secret, every possible code can be
  checked against the HMAC in about a million operations. This is acceptable
  because a code lives 10 minutes and is refused after 5 wrong tries.
- The link token is 32 random bytes; only its HMAC is stored.

## Client secrets: storage and provisioning

- Confidential OIDC client secrets are encrypted at rest with AES-256-GCM using
  a 32-byte HKDF subkey derived from `KEY_ENCRYPTION_SECRET` (purpose
  `client-secret`), rather than hashed, because `oidc-provider` requires the
  plaintext secret to authenticate clients (`client_secret_basic` /
  `client_secret_post`).
- Secrets are never returned after creation or rotation, never exposed by
  `GET /clients` or `tunnus-admin clients list`, and never written to logs or
  `audit_events`.
- When provisioning locally via `tunnus-admin clients put` or `rotate-secret`,
  supplied secrets are read from `--secret-env <VAR>` (never argv) and never
  printed to stdout or stderr. Generated secrets (32 random bytes, base64url)
  are printed once on stdout.

## Limits and lockouts

| Limit                               | Setting                         | Scope                                                           |
| ----------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| Codes per address per hour          | `RATE_LIMIT_EMAIL_PER_HOUR` (5) | Address                                                         |
| Codes per IP per hour               | `RATE_LIMIT_IP_PER_HOUR` (20)   | IP (needs `TRUST_PROXY` set correctly)                          |
| Codes per day                       | `MAIL_DAILY_CAP` (500)          | All; sign-up codes stop at the cap, login codes at 1.5 times    |
| Failed code or link attempts        | 5 per code                      | Code                                                            |
| Failed attempts across interactions | 10 in one hour                  | Address (lockout for the hour, L13)                             |
| Failed admin authentication         | 20 in 10 minutes                | IP, in memory per process; valid tokens are never refused by it |
| Failed mail relay authentication    | 20 in 10 minutes                | IP, in memory per process; valid tokens are never refused by it |

The code limits (per address, per IP, daily and the lockout) are counted in the
database and checked in one transaction under advisory locks, so concurrent
requests and several replicas cannot exceed them. The admin failure limit is
the exception: it is counted in memory, so each process counts on its own.

An attacker who knows an address can use up its codes and lock the owner out
for an hour. Sign-up floods can use up the daily cap, but login codes keep
working up to 1.5 times the cap. There is no challenge (CAPTCHA) step; add one
at the reverse proxy if the lockout is abused.

## Other points

- Responses for known and unknown addresses are the same. Mail sending runs in
  the background, so the response does not reveal whether a mail was sent.
- Mail provider errors are audited with the error name only. Audit details
  hold no addresses.
- Pages are served with a strict Content-Security-Policy and no scripts.
- Refresh tokens rotate, and disabling or deleting a user ends its sessions and
  revokes its tokens.
