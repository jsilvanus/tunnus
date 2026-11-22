# MCP OAuth Centralization and Back-Channel Revocation Plan

## Context & Objectives

Currently, Tunnus operates as the central OpenID Connect (OIDC) identity provider and exposes its own MCP server for administrative self-service. Several downstream applications connected to Tunnus (such as `ptv-mcp`) also expose MCP endpoints to AI clients (e.g., Claude, Cursor, ChatGPT).

However:
1. Downstream applications historically issued their own independent OAuth grants/tokens for MCP, causing fragmentation: Tunnus has no visibility into external AI connections made to downstream applications.
2. In Tunnus (`v0.9.7`), `/account` displays "Authorized applications" querying local `oidc_payloads`, but revoking an application only deletes the local grant and does not notify the downstream application.
3. Connected applications maintain active web sessions and MCP tokens until local expiration, regardless of revocation in Tunnus.

This plan details the centralization of MCP OAuth on Tunnus as the single Authorization Server (AS) using **RFC 9728 (OAuth 2.0 Protected Resource Metadata)** and **RFC 8707 (Resource Indicators for OAuth 2.0)**, combined with **OpenID Connect Back-Channel Logout 1.0 & Security Event Tokens (RFC 8417)** for immediate downstream revocation.

---

## Architecture Overview

```
                      +---------------------------------------+
                      |       AI Client (Claude / Cursor)     |
                      +---------------------------------------+
                           |                             ^
       1. Connects to MCP  |                             | 3. OAuth with
          (Streamable HTTP)|                             |    resource=...
                           v                             v
           +-------------------------+       +-------------------------+
           | Downstream App (PTV-MCP)|       |         Tunnus          |
           | [OAuth Resource Server] |       |   [Authorization Server]|
           +-------------------------+       +-------------------------+
                 |            ^                             |
  2. Returns 401 |            | 4. MCP Call with            | 5. Back-Channel
     RFC 9728 AS |            |    RS256 JWT                |    Logout / Revoke
     pointing to |            |    (aud: ptv-mcp)           |    (on /account
     Tunnus      |            |                             |     revocation)
                 v            +-----------------------------+
```

1. **AI Client connects to Downstream MCP**: AI client attempts to call downstream MCP.
2. **RFC 9728 Protected Resource Challenge**: Downstream app returns a 401 / tool-level OAuth challenge advertising Tunnus as the `authorization_server` and itself as the `resource`.
3. **Centralized Grant in Tunnus**: AI client authenticates against Tunnus. Tunnus records the `Grant` in `oidc_payloads` containing the target resource indicator, client ID, and scopes (`mcp`).
4. **Verification via JWKS**: Downstream app receives RS256 JWT access token issued by Tunnus, verifies it against Tunnus JWKS (`<issuer>/jwks`), and matches `aud` to its own resource URI and `sub` to its local user.
5. **Back-Channel Revocation**: When the user revokes the grant on Tunnus `/account` (or is disabled/removed from a group), Tunnus sends a signed `logout_token` / Security Event Token to the downstream app's `backchannel_logout_uri`.

---

## Detailed Tunnus Changes

### 1. Multi-Resource Indicator Support (`src/oidc/provider.js`)

Currently, `src/oidc/provider.js` restricts resource indicators to `config.mcp.resourceUrl`:
```javascript
// Current limitation in src/oidc/provider.js:
getResourceServerInfo: (_ctx, resourceIndicator) => {
  if (resourceIndicator !== config.mcp.resourceUrl) return undefined;
  ...
}
```

**Plan**:
- Extend `getResourceServerInfo` to accept downstream resource indicators.
- Source allowed resource URIs from client metadata (`allowed_resources` in `clients.json`) or validate against registered client URLs.
- For valid downstream resource indicators:
  - Issue RS256 JWT access tokens.
  - Set `audience: resourceIndicator`.
  - Set `scope: 'mcp'`.
  - Set `accessTokenTTL: 600` (10 minutes).

### 2. Rich Grants Display on `/account` (`src/web/account.js` & `pages.js`)

Currently, `/account` lists apps by `clientId` and `scopes`.
**Plan**:
- Inspect `payload.resources` or resource parameters stored with the grant in `oidc_payloads`.
- Resolve human-readable labels for target resources (e.g. "PTV Palvelutietovaranto MCP", "Tunnus Admin MCP").
- Group multiple grants under the same client/app or distinguish specific resource permissions.
- Display granted timestamp (`iat`) and expiration status.

### 3. Back-Channel Dispatcher (`src/oidc/backchannel.js`)

Implement a reusable dispatcher for back-channel logout and revocation:
- **Contract**: OpenID Connect Back-Channel Logout 1.0 + RFC 8417 (Security Event Token).
- **Token Claims**:
  - `iss`: Tunnus issuer URL.
  - `sub`: User ID (`user.id`).
  - `aud`: Client ID (e.g., `ptv-mcp`).
  - `iat`: Timestamp.
  - `jti`: Unique event ID.
  - `events`:
    ```json
    {
      "http://schemas.openid.net/event/backchannel-logout": {},
      "https://tunnus.fi/event/mcp-revoke": {
        "grant_id": "...",
        "resource": "https://..."
      }
    }
    ```
- **Dispatch Logic**:
  - Look up client in `provider.Client.find(clientId)`.
  - Check for `backchannel_logout_uri`.
  - Sign token using the current active Tunnus signing key (same key in JWKS).
  - POST to `backchannel_logout_uri` with `Content-Type: application/x-www-form-urlencoded` and body `logout_token=<signed_jwt>`.
  - Timeout after 5 seconds; do not block user HTTP response on downstream network latency (handle via background task / audit log on failure).

### 4. Wiring Revocation Events

Trigger back-channel dispatch in:
1. `POST /account/apps/revoke`: When user revokes an app, delete grant from `oidc_payloads` AND dispatch backchannel revoke to that client.
2. Admin user disable/delete (`src/admin/handlers/users.js`): Dispatch to all clients where user has active grants or sessions.
3. Group removal (`src/admin/handlers/memberships.js`): Dispatch to clients associated with the removed group if applicable.

---

## Implementation Steps for Tunnus

1. **Step 1: Resource Indicators Configuration**
   - Update `src/oidc/provider.js` to allow downstream resource indicators configured via clients or regex/list.
   - Add unit tests for resource indicator validation.
2. **Step 2: Back-Channel Token Generator & Dispatcher**
   - Create `src/oidc/backchannel.js` using `oidc-provider` keystore or existing RS256 signer in `src/oidc/keys.js`.
   - Write integration tests verifying generated token structure and JWKS verifiability.
3. **Step 3: Account Revocation Integration**
   - Update `POST /account/apps/revoke` in `src/web/account.js` to invoke the dispatcher.
   - Update `src/web/pages.js` to show target resource in the apps table.
4. **Step 4: Roadmap & Documentation**
   - Update `docs/TODO.md` to move back-channel logout and central MCP resource indicator items into active development / done.
