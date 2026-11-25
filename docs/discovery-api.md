# Tunnus Service Discovery & Registry Architecture

This document specifies the Service Discovery & Catalog extension for **Tunnus**, serving as the central directory for all parish APIs, web services, and edge Pi-ecosystem nodes (e.g. Pi Program, Pi Gateway, Sissi Infonäytöt, Anno API).

The formal OpenAPI 3.1 contract is located at [`docs/discovery-api-contract.yaml`](discovery-api-contract.yaml).

---

## 1. Motivation & Use Case

In Riihimäen seurakunta, client applications and web panels need to communicate with different instances of backend services:
- **Canva App (`canva-pieco-app`)**: Needs to push slides and control live projectors at different venues (Keskuskirkko, Kappeli, Seurakuntakeskus) without hardcoded static bundles.
- **Signage Screens & Display Players**: Need to know their local Gateway and content servers.
- **Relay & Edge Nodes**: Edge Raspberry Pi daemons connect to VPS tunnels; Tunnus maintains the canonical map of public/relay URLs.

Since Tunnus is already the **single source of truth for identity and OAuth2/OIDC clients**, hosting the service directory in Tunnus provides:
1. **Dynamic runtime configuration** backed by PostgreSQL.
2. **Zero-effort CLI & MCP management**: operations in the OpenAPI contract automatically become `tunnus services ...` commands and AI MCP tools.
3. **Consistent auth models**: services define whether they accept OIDC tokens, shared API keys, or relay tokens.

---

## 2. API Endpoints Overview

### A. Client Discovery API (Public / Consumer)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/discovery` | `GET` | List all active services. Supports query filters: `?type=`, `?venue=`, `?capability=` |
| `/api/v1/discovery/{type}` | `GET` | Shortcut to list services of a given type (e.g. `/api/v1/discovery/piprogram`) |

#### Example Response (`GET /api/v1/discovery?type=piprogram`):
```json
{
  "updated_at": "2026-11-25T15:00:00Z",
  "services": [
    {
      "id": "keskuskirkko-piprogram",
      "name": "Keskuskirkko — Sali (Pi Program)",
      "type": "piprogram",
      "venue": "keskuskirkko",
      "url": "https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443/program",
      "auth": {
        "type": "api_key",
        "header_name": "X-API-Key"
      },
      "capabilities": ["slides", "stage_display", "ftb", "shutter"],
      "metadata": {
        "pipeline": "primary",
        "display_targets": ["projector_left", "projector_right", "side_screen"]
      }
    }
  ]
}
```

---

### B. Admin Management API (`<issuer>/admin/api/v1`)

Requires an admin token (`Authorization: Bearer tun_...`).

| Method | Path | CLI Command | MCP Tool |
|---|---|---|---|
| `GET` | `/admin/api/v1/services` | `tunnus services list` | `list_admin_services` |
| `POST` | `/admin/api/v1/services` | `tunnus services create` | `create_admin_service` |
| `GET` | `/admin/api/v1/services/{id}` | `tunnus services get <id>` | `get_admin_service` |
| `PUT` | `/admin/api/v1/services/{id}` | `tunnus services put <id>` | `put_admin_service` |
| `PATCH` | `/admin/api/v1/services/{id}` | `tunnus services update <id>` | `update_admin_service` |
| `DELETE` | `/admin/api/v1/services/{id}` | `tunnus services delete <id>` | `delete_admin_service` *(excluded by default)* |

---

## 3. Database Schema Concept (`010_discovery_services.sql`)

```sql
CREATE TABLE IF NOT EXISTS discovery_services (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (type ~ '^[a-z0-9_-]{1,32}$'),
  venue text NOT NULL CHECK (venue ~ '^[a-z0-9_-]{1,32}$'),
  url text NOT NULL CHECK (url ~ '^https?://'),
  auth jsonb NOT NULL DEFAULT '{"type":"none"}'::jsonb,
  capabilities text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS discovery_services_type_idx ON discovery_services(type);
CREATE INDEX IF NOT EXISTS discovery_services_venue_idx ON discovery_services(venue);
CREATE INDEX IF NOT EXISTS discovery_services_disabled_idx ON discovery_services(disabled);
```

---

## 4. Export Targets & Publishing Specifications (`export_targets`)

To support client applications (such as Canva companion apps, automated media pipelines, and web signages) pushing content to specific venues, screens, and broadcast switchers without hardcoded configurations, services can declare export targets under `metadata.export_targets`.

Clients query `GET /api/v1/discovery?capability=export_target` to retrieve all eligible publishing targets across the parish.

### Core Principles

1. **Flattened Nesting (`metadata.export_targets`):**
   Targets are placed directly under `metadata.export_targets` as an array to keep frontend parsing simple (`service.metadata?.export_targets?.map(...)`).

2. **Ingest URL Resolution:**
   - If `target.ingest.url` is an absolute URL (`https://...`), use it directly.
   - If `target.ingest.path` is relative (`/api/v1/...`), resolve it against the service root:
     ```javascript
     const uploadUrl = target.ingest.url
       ? target.ingest.url
       : new URL(target.ingest.path, service.endpoint_url || service.url).toString();
     ```

3. **Inherit Service Auth:**
   The client reuses the parent service's `auth` configuration (e.g. `api_key` or `oidc` token) when posting to `target.ingest.path`, unless explicitly overridden in `target.ingest.auth`.

### Example Discovery Payload (`export_targets`)

```json
{
  "updated_at": "2026-11-25T17:45:00Z",
  "services": [
    {
      "id": "keskuskirkko-piprogram",
      "name": "Keskuskirkko — Sali (Pi Program)",
      "type": "piprogram",
      "venue": "keskuskirkko",
      "url": "https://gateway.keskuskirkko.riihimaenseurakunta.fi:8443",
      "auth": {
        "type": "api_key",
        "header_name": "X-API-Key"
      },
      "capabilities": ["slides", "stage_display", "export_target"],
      "metadata": {
        "export_targets": [
          {
            "id": "sali-valkokangas-16-9",
            "name": "Pääsalin valkokangas (16:9)",
            "category": "slides",
            "aspect_ratio": "16:9",
            "resolution": {
              "width": 1920,
              "height": 1080,
              "pixel_ratio": 1
            },
            "formats": ["png", "jpeg"],
            "multi_page": true,
            "ingest": {
              "path": "/api/v1/pipgm/items",
              "method": "POST",
              "field_name": "files"
            },
            "prefill_rules": {
              "extract_text": false
            }
          }
        ]
      }
    },
    {
      "id": "sissi-signage",
      "name": "Kyltti / Sissi Infonäytöt",
      "type": "signage",
      "venue": "parish-wide",
      "url": "https://kehitys.riihimaenseurakunta.fi/sissi",
      "auth": {
        "type": "oidc",
        "client_id": "canva-pieco-app",
        "scopes": ["signage:write"]
      },
      "capabilities": ["screen_push", "playlist_management", "export_target"],
      "metadata": {
        "export_targets": [
          {
            "id": "keskuskirkko-aula-portrait",
            "name": "Keskuskirkon eteisaula (Pysty 9:16)",
            "category": "signage",
            "aspect_ratio": "9:16",
            "resolution": {
              "width": 1080,
              "height": 1920
            },
            "formats": ["png", "jpeg", "mp4"],
            "multi_page": false,
            "ingest": {
              "path": "/api/screens/keskuskirkko-aula/content",
              "method": "POST"
            },
            "prefill_rules": {
              "extract_text": true,
              "field_mapping": {
                "heading": "title",
                "body": "description"
              }
            }
          }
        ]
      }
    }
  ]
}
```
