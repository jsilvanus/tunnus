# MCP identity pseudonymisation: implementation plan

**Status:** design plan; no runtime changes in this PR  
**Target:** Tunnus account UI, PostgreSQL, admin API/MCP boundary  
**Related design:** [CLI and MCP](cli-mcp.md), [admin API](admin-api.md), [MCP centralisation](mcp-centralization-plan.md)

## 1. Goal

Allow each Tunnus administrator to decide what identity information each connected MCP client may see when using that administrator's authority.

The account owner can maintain user-scoped pseudonyms such as `kirkkoherra`, `Person A`, or `Person B`. For each MCP authorization client, the owner selects one identity mode:

| Mode | Identity visible to MCP |
| --- | --- |
| `normal` | Existing admin API identity fields (email, display name, UUID, etc.); compatibility default |
| `uuid` | Stable Tunnus user UUIDs, with human identity fields removed |
| `pseudonym` | Owner-defined pseudonyms, with UUIDs and human identity fields removed |

The mode is configured per owner and per authenticated MCP client/credential. Pseudonym definitions belong to the owner, not to a client, so the same mapping can be reused by several clients. A user's pseudonym is an alias for that user's Tunnus account; it is not a group role or a permission in itself.

Example: an owner maps a Tunnus user to `kirkkoherra`, enables `pseudonym` for their MCP client, and asks the assistant to grant `kirkkoherra` membership in `group/abc`. The MCP boundary resolves the alias to the internal UUID before calling the admin API. The API response is then transformed back to the alias before it reaches the MCP client. The model does not need the person's name, email address, or UUID.

## 2. Current architecture and implications

- `bin/tunnus-mcp.js` starts either stdio MCP (local admin token) or Streamable HTTP MCP.
- `src/mcp/http.js` authenticates every stateless HTTP request. It can identify an admin-token owner through `resolveTokenUser`, or an OAuth subject through the JWT verifier. OAuth verification currently returns the subject and claims, but the HTTP layer only retains the subject.
- `src/mcp/server.js` generates MCP tools from `openapi.yaml` via `clientOperations()`, forwards calls to the admin API, and currently returns the admin API response unchanged in both `structuredContent` and text content. Mutative actions can be staged; staged payloads and execution results also contain user identifiers and must be considered.
- `src/admin/serialize.js` defines the user and membership response shapes. In particular, user objects include UUID, email, display name, title, and phone number; memberships include user UUID, email, and display name.
- `src/web/account.js` already lists authorized MCP/OIDC clients from OIDC grants and renders the account page. It is the natural place to expose per-client identity mode and a pseudonym-management link/page.
- The MCP HTTP transport is stateless and creates a server per request. Do not use MCP `clientInfo.name` as a security boundary: it is client-supplied metadata and is not a trustworthy or necessarily stable identity. Use the authenticated Tunnus credential as the key.

The current HTTP auth paths have different client identifiers:
- OAuth: use the verified token's `client_id` claim (and owner subject), after confirming that this claim is present and valid for the issued token.
- Admin token: use the database admin-token row ID (and its owner user ID). A token label is display-only and must not be used as a key.
- Local stdio: it has no server-side authenticated client identity beyond the configured admin token. Treat that token as the credential key. If the same token is reused by multiple MCP applications, they necessarily share one mode; separate tokens provide separate settings.

This makes the effective setting key `(owner_user_id, auth_kind, auth_client_key)`. It is intentionally scoped to the authenticated credential, not the MCP initialize client name.

## 3. Data model

Add a forward-only migration (next available migration number) with two tables.

### `mcp_pseudonyms`

- `owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `pseudonym text NOT NULL`
- timestamps for creation/update
- primary key or unique constraint on `(owner_user_id, subject_user_id, pseudonym)`
- unique constraint on `(owner_user_id, normalized_pseudonym)` (normalization rules must be explicit and deterministic)

Allow an owner to define multiple aliases for one subject (for example a role-based alias and a neutral alias), but do not allow the same alias to identify two subjects for the same owner. Do not expose the owner/subject mapping through the admin API or MCP. Enforce reasonable length and character limits, trim whitespace, and compare aliases case-insensitively. Decide whether aliases may contain spaces; supporting `Person A` is useful, but normalization must remain unambiguous.

### `mcp_client_settings`

- `owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'admin_token'))`
- `auth_client_key text NOT NULL` (OAuth `client_id` or admin-token row UUID)
- `identity_mode text NOT NULL CHECK (identity_mode IN ('normal', 'uuid', 'pseudonym'))`
- timestamps
- primary key on `(owner_user_id, auth_kind, auth_client_key)`

No row means `normal`, preserving current behaviour for existing clients. Deleting a user cascades their settings and pseudonyms. Revoking/deleting an admin token or OIDC client should remove or make its settings unreachable; add cleanup where the lifecycle currently does not cascade.

Pseudonyms are personal data when they can be linked to a person. Keep mappings server-side, restrict reads/writes to the owner, never include mappings in audit details, and do not log resolved UUIDs alongside aliases unnecessarily. This feature is pseudonymisation, not anonymisation: a role alias such as `kirkkoherra` can itself reveal information.

## 4. Identity boundary and transformation

Implement a dedicated, tested module in `src/mcp/` (for example `identity.js`) that receives the authenticated owner, credential key, selected mode, pseudonym repository, operation metadata, and API result.

### Inputs: alias to canonical UUID

For operations that accept a user reference (for example group grant/revoke and user get/update/delete):
1. Mark user-reference parameters in `openapi.yaml` with explicit Tunnus metadata such as `x-tunnus-user-reference: true`. Do not infer solely from names or recursively replace arbitrary strings.
2. In `pseudonym` mode, resolve the supplied alias within the authenticated owner's mappings. Reject unknown or ambiguous aliases with a generic error. Do not silently fall back to UUID, email, or display-name lookup.
3. In `uuid` mode, accept UUID references only.
4. In `normal` mode, preserve existing API input semantics.
5. Validate the resolved subject is still an eligible existing user through the admin API's normal authorization and validation path. Never let a pseudonym bypass authorization.

### Outputs: canonical UUID to selected representation

Transform both MCP `structuredContent` and the text representation from one canonical transformed object; never sanitize only one representation.

Use explicit response-field metadata/projections for user-bearing operations. At minimum cover:
- user list/get/create/update responses;
- group membership list/grant/revoke responses;
- any nested user objects in other admin responses;
- mutative direct-call results;
- staged action summaries/details and `getCommitList`;
- `executeCommitList` results.

In `uuid` mode, retain UUID references but remove email, display name, phone number, title, and other direct identity fields. In `pseudonym` mode, replace user UUIDs with the configured alias and remove those direct identity fields. If a response contains a user for whom no alias exists, return a stable non-identifying placeholder or a clear redacted marker; never fall back to UUID/name/email. The placeholder must not accidentally be interpreted as a resolvable alias.

Do not perform an indiscriminate recursive string replacement: group names, descriptions, audit text, and arbitrary values may coincidentally equal a pseudonym. Prefer explicit schema annotations and operation-aware transformations. Unknown user-bearing response shapes should fail closed in pseudonym mode (or be explicitly redacted), not pass through unreviewed.

In pseudonym mode, remove or constrain search inputs that expose direct identifiers (for example email/name search in `listUsers`) unless a separately designed pseudonym-aware search is implemented. Tool schemas/descriptions must explain that user references are pseudonyms in this mode. The model should not be encouraged to ask for names or email addresses.

## 5. Account UI and owner APIs

Add an account subpage, linked from the existing account page, for **MCP pseudonyms**:
- list the owner's pseudonyms, showing the alias and the corresponding person using identity fields only in this authenticated human-facing page;
- add an alias by selecting/searching an existing user and entering a pseudonym;
- edit/rename and delete an alias;
- validate uniqueness and display clear errors;
- explain that aliases are scoped to this account owner and are not shared with other administrators or MCP clients.

Add a per-client selector to the existing authorized-applications list, only for MCP clients:
- Normal identity (current behaviour)
- UUID only
- Pseudonyms

Persist the selection for the authenticated owner and the stable authenticated credential key. Show the client name and, where useful, the OAuth client ID/token label for the human administrator. A missing setting displays Normal identity. Protect all POST routes with the existing account-session and CSRF checks. Require an authenticated account owner; do not rely on the MCP admin API's broad admin-only surface for these self-service operations.

Use account-scoped service functions shared by the page and MCP runtime. If an owner-facing JSON API is useful, keep it under the account router and do not expose pseudonym mappings as general admin API operations.

## 6. Authentication and client identity plumbing

Extend the verified auth context without trusting request-supplied identifiers:
- Preserve validated OAuth JWT claims (especially `client_id`) from `verifyMcpJwt` through `createMcpHttpApp`.
- For admin tokens, preserve the validated token row ID from `resolveTokenUser`; do not key by token text or label.
- Pass a normalized identity context into `createMcpServer`: owner UUID, auth kind, credential key, and selected identity mode.
- Resolve settings on each stateless request (or use a cache with explicit invalidation) so a changed setting takes effect without restarting the MCP service.
- If client identity cannot be established, do not apply another client's setting. Use the documented safe behaviour; for pseudonym mode, fail closed rather than accidentally returning normal identity data.

The stdio path needs the same identity handling. Its configured token is not currently resolved to an owner/client context locally; add a narrowly scoped authenticated identity lookup (or an authenticated admin endpoint) rather than parsing the token or trusting a CLI config label. Document the limitation if this cannot be supported in the first implementation slice.

## 7. Staged actions and audit

The current commit-list mechanism persists original operation parameters and actor metadata. Ensure pseudonym mode does not leak canonical UUIDs, names, or emails through:
- MCP responses from `getCommitList`;
- the immediate response when an action is staged;
- the commit list shown on the account page;
- direct execution and commit-list execution results.

Keep canonical IDs in the server-side staged payload so execution remains correct, but apply the same output transformation when returning the list/results to MCP. The human account page may continue to show canonical details to the authenticated owner. Audit records should retain only the minimum needed for accountability; do not add alias-to-UUID mappings to audit details. Test that error messages do not interpolate canonical identifiers.

## 8. Rollout and compatibility

- Migration is additive and defaults every existing MCP credential to `normal`.
- Existing stdio and HTTP configurations continue working.
- Do not silently enable pseudonymisation for existing clients.
- UI changes are account-owner-only; existing account and MCP flows remain available.
- A mode change should take effect on the next stateless request. For long-lived stdio sessions, either refresh settings per tool call or document/restart semantics.

## 9. Implementation sequence

1. **Contract and metadata:** annotate user-reference input fields and user-bearing output schemas in `openapi.yaml`; write down every operation/field requiring transformation.
2. **Persistence:** add migration and repository functions for pseudonyms and per-credential settings; add constraints, normalization, cascade behaviour, and tests.
3. **Identity context:** extend OAuth and admin-token authentication plumbing; define a typed identity context for HTTP and stdio.
4. **Core transformation:** implement alias resolution, UUID-only projection, pseudonym output projection, search restrictions, and fail-closed behaviour. Unit-test pure transformations.
5. **MCP integration:** apply transformations consistently to all read, direct-mutative, staged, commit-list, and execution paths. Ensure both text and structured content match.
6. **Account management:** add pseudonym CRUD page and per-MCP-client mode controls with CSRF, owner isolation, validation, and audit events that do not reveal mappings.
7. **Integration/conformance tests:** test OAuth and admin-token clients, two owners, two clients for one owner, unknown aliases, missing aliases, duplicate aliases, disabled/deleted users, revoked credentials, and mode changes.
8. **Documentation:** update `docs/cli-mcp.md`, admin/account docs, and `openapi.yaml` descriptions as implementation lands.

## 10. Security and acceptance tests

The feature is not complete until tests prove all of the following:

- Owner A cannot read, create, update, or delete Owner B's aliases/settings, even by supplying Owner B's UUID.
- Two owners can use the same alias for different people without collision or cross-account disclosure.
- One owner can configure separate modes for two MCP credentials; changing one does not affect the other.
- Normal mode remains byte-for-byte compatible for existing MCP results where practical.
- UUID mode never returns email, display name, phone, title, or other direct identifiers.
- Pseudonym mode never returns UUID, email, display name, phone, or title in text, structured content, errors, staged data, or execution results.
- Pseudonym input resolves only within the authenticated owner's mapping; unknown aliases and raw UUIDs are rejected in pseudonym mode.
- An alias for a deleted user is removed or safely invalidated; a disabled user remains subject to existing admin API policy.
- OAuth client identity comes from a verified claim; admin-token identity comes from a validated database token row; client-supplied MCP metadata is never used as an authorization key.
- Search filters and tool descriptions do not invite identity disclosure in pseudonym mode.
- Account routes enforce session authentication and CSRF, and mappings are never exposed to MCP management tools.

## 11. Open design decisions before implementation

- **Pseudonym scope:** this plan chooses owner-global aliases reused by that owner's MCP clients. If aliases must differ per MCP client, add `auth_kind/auth_client_key` to the pseudonym key rather than silently changing semantics.
- **Unmapped users:** choose between a generic placeholder (best for list completeness) and omitting the user-bearing record. Never fall back to a stable UUID in pseudonym mode.
- **Role aliases:** aliases such as `kirkkoherra` are convenient but may disclose a role. The UI should warn that pseudonyms are labels, not guaranteed anonymous identities.
- **Stdio identity:** determine whether to add an authenticated context endpoint or require separately provisioned tokens for separate local clients.
- **Tool schema filtering:** decide whether to dynamically tailor `listTools` schemas/descriptions by identity mode or keep stable schemas and reject disallowed fields at call time. The latter is simpler; the former gives better model guidance. Both require server-side enforcement.
