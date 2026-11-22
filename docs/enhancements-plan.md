# Tunnus Enhancements Plan: User Profile Fields, Lifecycle, Computed Groups & Account Search

This document defines the 3-phase implementation plan for enhancements to Tunnus.

---

## Phase 1: Title, Phone Number, Account Lifecycle & Auto-Disabling

### 1. Database Schema (`migrations/007_user_title_phone_lifecycle.sql`)
- Add columns to `users`:
  - `title text DEFAULT NULL`
  - `phone_number text DEFAULT NULL`
  - `activates_at timestamptz DEFAULT NULL`
  - `disables_at timestamptz DEFAULT NULL`
  - `disabled_at timestamptz DEFAULT NULL`
- Add index `users_lifecycle_idx` on `(status, activates_at, disables_at)`.

### 2. Core Domain Logic (`src/accounts.js`)
- Update `loadUser` to select `title`, `phone_number`, `activates_at`, `disables_at`, `disabled_at`.
- Helper `isAccountActive(user, now = new Date())`:
  - True if `user.status === 'active'` AND (`activates_at IS NULL` OR `activates_at <= now`) AND (`disables_at IS NULL` OR `disables_at > now`).
- In `createFindAccount(pool)`:
  - If `!isAccountActive(user)`, return `undefined` (blocking OIDC client tokens, refresh tokens, and userinfo).
- Explicitly exclude `title` and `phone_number` from OIDC claims in `createFindAccount`.

### 3. Back-Channel Logout & Revocation Broadcast (`src/oidc/backchannel.js`)
- Implement `dispatchAllBackchannelLogouts({ config, pool, getProvider, userId, reason })`:
  - Discover all clients where user has active grants/sessions in `oidc_payloads`.
  - Also inspect registered clients in provider with `backchannel_logout_uri`.
  - Dispatch signed RS256 `logout_token` with backchannel logout & MCP revoke events to each client.
  - Delete user sessions/grants from `oidc_payloads`.
  - Revoke admin tokens.
  - Audit event.

### 4. Background Lifecycle Scheduler (`src/jobs/cleanup.js`)
- `processAutoDisabling({ pool, config, getProvider, logger, now })`:
  - Find active users where `disables_at <= now`.
  - Set `status = 'disabled'`, `disabled_at = now`.
  - Trigger `dispatchAllBackchannelLogouts`.
  - Audit `user.auto_disabled`.
- `processAutoActivation({ pool, config, logger, now })`:
  - Find disabled users where `activates_at <= now` and (`disables_at IS NULL` OR `disables_at > now`).
  - Set `status = 'active'`, clear `disabled_at`.
  - Audit `user.auto_activated`.

### 5. Account Portal & Interactions (`src/web/account.js`, `src/web/pages.js`, `src/web/interactions.js`, `src/i18n.js`)
- Allow inactive users to sign in to `/account`:
  - Update `resolveAccount`, `/account/login`, `/account/login/resend`, and `/account/login/code` to accept inactive users.
- Display `Title`, `Phone number`, status badge (`Active` / `Inactive`), and scheduled activation/disabling times in the `/account` profile table.
- Display an informational warning banner on `/account` if the account is inactive.
- Reject inactive users in `src/web/interactions.js` when attempting to authorize external OIDC client applications.
- Add i18n keys for `title`, `phone_number`, `account_status`, `account_status_active`, `account_status_inactive`, `account_inactive_notice`, `account_activates_at`, `account_disables_at` (en, fi, sv).

### 6. Admin API & OpenAPI (`openapi.yaml`, `src/admin/serialize.js`, `src/admin/handlers/users.js`)
- Update `User`, `UserCreate`, and `UserUpdate` schemas with `title`, `phone_number`, `activates_at`, `disables_at`, `disabled_at`.
- When an admin updates `status` to `disabled`, trigger `dispatchAllBackchannelLogouts`.

---

## Phase 2: Computed / Implicit Groups (Group Implications)

### 1. Database Schema (`migrations/008_group_implications.sql`)
- Table `group_implications`:
  - `id bigserial PRIMARY KEY`
  - `source_group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE`
  - `implied_group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `UNIQUE (source_group_id, implied_group_id)`
  - `CHECK (source_group_id != implied_group_id)`

### 2. Dynamic Recursive CTE Resolution (`src/accounts.js`)
- Query user groups using a recursive CTE:
  - Base case: user's direct groups from `user_groups`.
  - Recursive step: follow `group_implications` (resolving transitive chains like A -> B -> C).
- Return deduplicated, sorted list of effective groups.
- Direct memberships remain unchanged in `user_groups`.
- OIDC claims and `/account` display effective groups automatically.

### 3. Admin API & OpenAPI Spec
- Endpoints in `openapi.yaml`:
  - `GET /group-rules`: List all implication rules with source and implied group details.
  - `POST /group-rules`: Create an implication rule `{ source_group, implied_group }`.
  - `DELETE /group-rules/{id}`: Delete an implication rule.
- Handler implementation in `src/admin/handlers/groupRules.js` (or `groups.js`).

---

## Phase 3: Consumer Backend User Directory & Account Search

### 1. Search Query Parameters & Matching (`openapi.yaml`, `src/admin/handlers/users.js`)
- Enhance `listUsers`:
  - General query parameter `q`: substring match across `display_name`, `email`, and `title`.
  - Specific parameter `title`: substring match for title.
  - Filter `status`: default or filterable (consumer backends query `status=active` for active account autocomplete).
- Provide clean, indexed query performance.

### 2. Consumer Backend Integration Pattern
- Consumer backends authenticate using their admin/service token or M2M OAuth client credentials.
- The consumer backend queries `GET /admin/api/v1/users?q=...&status=active` and maps the results to a minimal `{ id, displayName, email, title }` shape for frontend search autofill.

---

## Phase 4: Verification, Version Bump & Deployment

1. Write comprehensive Vitest unit and integration tests for each phase.
2. Run `npm test`, `npm run lint`, and `npm run typecheck`.
3. Bump package version in `package.json` / `package-lock.json`.
4. Git commit after each phase.
5. Push to remote and verify build/deployment readiness.
