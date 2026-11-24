# MCP identity pseudonymisation: implementation plan

**Status:** design plan; no runtime changes in this PR  
**Target:** Tunnus account UI, PostgreSQL, admin API/MCP boundary  
**Related design:** [CLI and MCP](cli-mcp.md), [admin API](admin-api.md), [MCP centralisation](mcp-centralization-plan.md)

## 1. Goal

Allow each Tunnus administrator to decide what identity information each connected MCP client may see when using that administrator's authority.

The owner maintains a user-scoped identity directory containing one or more pseudonyms for a target. A target may be an existing Tunnus user, or an external person who does not yet have a Tunnus account. The directory is independent of MCP clients; the same aliases can be used by several clients. For each authenticated MCP credential, the owner selects one of two modes:

| Mode | Identity visible to MCP |
| --- | --- |
| `normal` | Existing identity fields (email, display name, UUID, etc.); compatibility default |
| `pseudo` | UUIDs and pseudonyms only; no real names, email addresses, phone numbers, titles, or other direct identity fields |

`pseudo` is one combined mode, not a separate UUID-only mode. The assistant may use either a UUID or a pseudonym as a user reference. A pseudonym is an alias, not a role or permission. Multiple aliases may refer to the same target (for example `kirkkoherra`, `Person A`, and `A`). One alias must be designated as the preferred display alias; other aliases remain valid input aliases. If no preferred alias exists, output the UUID.

Use an explicit `pseudo:<alias>` identifier when the assistant supplies a pseudonym, for example `pseudo:kirkkoherra`. This avoids collisions with UUIDs and makes the identifier type unambiguous. In `pseudo` mode, UUID input is also accepted. Do not accept bare names, email addresses, or unprefixed aliases. In `normal` mode, preserve existing identifier semantics.

Example: the owner creates `pseudo:kirkkoherra` for a target, enables `pseudo` for an MCP client, and asks the assistant to grant `pseudo:kirkkoherra` membership in `group/abc`. The MCP boundary resolves the alias to the linked Tunnus user's UUID before calling the admin API. The response contains the preferred alias (or UUID if no preferred alias exists), never the person's real identity fields.

An external target can be pseudonymised before becoming a Tunnus user. Such a target can be listed and referred to in conversation, but operations requiring a Tunnus account (such as granting group membership) must report that the target is not yet linked to a Tunnus user; they must not create or guess an account.

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

Add a forward-only migration (next available migration number) with an owner-scoped identity directory, aliases, and client settings.

### `mcp_identity_subjects`

- internal UUID primary key;
- `owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`;
- nullable `tunnus_user_id uuid REFERENCES users(id) ON DELETE SET NULL`;
- optional owner-only descriptive label/notes for the account UI;
- timestamps.

A subject exists independently of a Tunnus account. This permits the owner to create a pseudonym for an external person now and link it to a Tunnus user later. Enforce uniqueness for `(owner_user_id, tunnus_user_id)` where the Tunnus user is not null, so one owner does not accidentally create duplicate directory subjects for the same account. Linking/unlinking must be an explicit owner action.

### `mcp_pseudonyms`

- `owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`;
- `subject_id uuid NOT NULL REFERENCES mcp_identity_subjects(id) ON DELETE CASCADE`;
- `pseudonym text NOT NULL`;
- `is_preferred boolean NOT NULL DEFAULT false`;
- timestamps;
- unique constraint on `(owner_user_id, normalized_pseudonym)`;
- at most one preferred pseudonym per `(owner_user_id, subject_id)`.

Allow multiple aliases for one subject. Every alias is accepted as an input identifier using the `pseudo:` prefix. At most one alias is the preferred output representation. If none is preferred, represent that target by its Tunnus UUID when linked; external/unlinked subjects may be returned as a non-resolvable owner-scoped opaque subject identifier only in directory-management tools, not as a Tunnus user result. Do not expose owner/subject mappings through general admin API or MCP. Enforce reasonable length and character limits, trim whitespace, compare aliases case-insensitively, and allow spaces in aliases (for example `Person A`) while requiring exact content after normalization.

### `mcp_client_settings`

- `owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'admin_token'))`
- `auth_client_key text NOT NULL` (OAuth `client_id` or admin-token row UUID)
- `identity_mode text NOT NULL CHECK (identity_mode IN ('normal', 'pseudo'))`
- timestamps
- primary key on `(owner_user_id, auth_kind, auth_client_key)`

No row means `normal`, preserving current behaviour for existing clients. Deleting a user cascades their settings and pseudonyms. Revoking/deleting an admin token or OIDC client should remove or make its settings unreachable; add cleanup where the lifecycle currently does not cascade.

Pseudonyms are personal data when they can be linked to a person. Keep mappings server-side, restrict reads/writes to the owner, never include mappings in audit details, and do not log resolved UUIDs alongside aliases unnecessarily. This feature is pseudonymisation, not anonymisation: a role alias such as `kirkkoherra` can itself reveal information.

## 4. Identity boundary and transformation

Implement a dedicated, tested module in `src/mcp/` (for example `identity.js`) that receives the authenticated owner, credential key, selected mode, pseudonym repository, operation metadata, and API result.

### Inputs: UUID or explicit pseudonym to canonical target

For every operation that accepts or searches for a user reference (including group grant/revoke, user get/update/delete, membership checks, and all user lookup/check tools):
1. Mark user-reference parameters and user-bearing query filters in `openapi.yaml` with explicit Tunnus metadata such as `x-tunnus-user-reference: true`. Do not infer solely from field names or recursively replace arbitrary strings.
2. In `pseudo` mode, accept a valid Tunnus UUID or `pseudo:<alias>`. Resolve aliases only within the authenticated owner's directory. All aliases for a subject resolve to the same directory subject. Reject unknown aliases with a generic non-identifying error; never fall back to email, display name, or raw-name lookup.
3. If the directory subject is linked to a Tunnus user, resolve it to that user's canonical UUID before invoking the admin API. If it is not linked, reject operations that require a Tunnus account with a clear `target_not_linked` error that contains no personal identity data.
4. In `normal` mode, preserve existing API input semantics.
5. Validate the resolved Tunnus user through the admin API's normal authorization and eligibility path. A pseudonym must never bypass authorization.

### Outputs: canonical UUID to selected representation

Transform both MCP `structuredContent` and the text representation from one canonical transformed object; never sanitize only one representation.

Use explicit response-field metadata/projections for user-bearing operations. At minimum cover:
- user list/get/create/update responses;
- group membership list/grant/revoke responses;
- any nested user objects in other admin responses;
- mutative direct-call results;
- staged action summaries/details and `getCommitList`;
- `executeCommitList` results.

In `pseudo` mode, every user-bearing response and every user check/query result must be projected to an identity-only representation: the preferred `pseudo:<alias>` when one exists, otherwise the Tunnus UUID. Remove email, real/display name, phone, title, and all other direct identity fields. This applies consistently to list/get/search results, membership and group checks, existence checks, nested user objects, direct mutation results, staged-action summaries, commit-list results, and execution results. A user with several aliases is returned using only its preferred alias; all aliases remain valid inputs. Never return an arbitrary alias based on insertion order. The `get me` operation is the sole exception: it must always return the authenticated caller's own full user information, irrespective of mode, because it is explicitly self-information.

Do not perform an indiscriminate recursive string replacement: group names, descriptions, audit text, and arbitrary values may coincidentally equal a pseudonym. Prefer explicit schema annotations and operation-aware transformations. Unknown user-bearing response shapes should fail closed in pseudonym mode (or be explicitly redacted), not pass through unreviewed.

In `pseudo` mode, all user queries/checks must obey the same projection; do not leave a separate check endpoint returning names or emails. Remove or constrain search inputs that expose direct identifiers (for example email/name search) unless explicitly required for the `get me` exception. Tool schemas/descriptions must explain that user references are UUIDs or `pseudo:<alias>` in this mode. The `get me` exception must be identified by the authenticated subject, not by a caller-supplied user reference.

## 5. Account UI and owner APIs

Add an account subpage, linked from the existing account page, for **MCP pseudonyms**:
- list the owner's identity subjects, including external/unlinked targets, and their aliases;
- add a subject either by selecting an existing Tunnus user or creating an external/unlinked target;
- add multiple aliases to one subject, choose exactly one preferred display alias, and rename/delete individual aliases;
- link an external subject to a Tunnus user later, with duplicate-link prevention;
- show real identity fields only in this authenticated human-facing page when a linked Tunnus user exists;
- validate alias uniqueness and display clear errors;
- explain that aliases are scoped to this account owner and are not shared with other administrators or MCP clients.

Add a per-client selector to the existing authorized-applications list, only for MCP clients:
- Normal identity (current behaviour)
- Pseudonymised identity (UUIDs and pseudonyms only; no real identity fields)

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

1. **Contract and metadata:** annotate every user-reference input, user query/check, and user-bearing output in `openapi.yaml`; explicitly mark `get me` as the sole full-identity exception.
2. **Persistence:** add migration and repository functions for pseudonyms and per-credential settings; add constraints, normalization, cascade behaviour, and tests.
3. **Identity context:** extend OAuth and admin-token authentication plumbing; define a typed identity context for HTTP and stdio.
4. **Core transformation:** implement `pseudo:<alias>` and UUID input resolution, preferred-alias/UUID output projection, external-subject handling, user-query/check coverage, `get me` exception, and fail-closed behaviour. Unit-test pure transformations.
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
- In `pseudo` mode, every user query/check returns only the preferred pseudonym or UUID; it never returns real identity fields, except `get me`, which always returns the authenticated caller's full own profile.
- `pseudo` mode accepts both UUIDs and `pseudo:<alias>`; unprefixed names/emails are not accepted as user references.
- Multiple aliases resolve to one subject, and only the explicitly preferred alias is used in output; if none is preferred, output the UUID.
- External/unlinked subjects can have aliases, but Tunnus operations requiring an account fail safely until the subject is linked.
- Deleted/unlinked Tunnus users are safely invalidated; a disabled user remains subject to existing admin API policy.
- OAuth client identity comes from a verified claim; admin-token identity comes from a validated database token row; client-supplied MCP metadata is never used as an authorization key.
- Search filters and tool descriptions do not invite identity disclosure in pseudonym mode.
- Account routes enforce session authentication and CSRF, and mappings are never exposed to MCP management tools.

## 11. Open design decisions before implementation

- **Pseudonym scope:** this plan chooses owner-global aliases reused by that owner's MCP clients. If aliases must differ per MCP client, add `auth_kind/auth_client_key` to the pseudonym key rather than silently changing semantics.
- **Preferred alias:** this plan chooses one explicitly preferred output alias per target; other aliases are input aliases. If no alias is preferred, output the UUID. This makes multiple aliases deterministic without hiding the fallback identity token.
- **Role aliases:** aliases such as `kirkkoherra` are convenient but may disclose a role. The UI should warn that pseudonyms are labels, not guaranteed anonymous identities.
- **Stdio identity:** determine whether to add an authenticated context endpoint or require separately provisioned tokens for separate local clients.
- **Tool schema filtering:** decide whether to dynamically tailor `listTools` schemas/descriptions by identity mode or keep stable schemas and reject disallowed fields at call time. The latter is simpler; the former gives better model guidance. Both require server-side enforcement.
- **`get me` operation mapping:** identify the exact OpenAPI operation that represents the authenticated caller's own profile and guarantee that it cannot be redirected to another user by a supplied UUID or pseudonym.
