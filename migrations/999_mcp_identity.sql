-- Owner-scoped MCP identity directory, per-credential modes, and expiring references.
CREATE TABLE IF NOT EXISTS mcp_identity_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tunnus_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  label text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_identity_subjects_linked_user_idx
  ON mcp_identity_subjects (owner_user_id, tunnus_user_id)
  WHERE tunnus_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_identity_subjects_owner_idx
  ON mcp_identity_subjects (owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_pseudonyms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES mcp_identity_subjects(id) ON DELETE CASCADE,
  pseudonym text NOT NULL,
  normalized_pseudonym text NOT NULL,
  is_preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, normalized_pseudonym)
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_pseudonyms_one_preferred_idx
  ON mcp_pseudonyms (owner_user_id, subject_id)
  WHERE is_preferred = true;
CREATE INDEX IF NOT EXISTS mcp_pseudonyms_subject_idx
  ON mcp_pseudonyms (owner_user_id, subject_id);

CREATE TABLE IF NOT EXISTS mcp_client_settings (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'admin_token')),
  auth_client_key text NOT NULL,
  identity_mode text NOT NULL CHECK (identity_mode IN ('open', 'pseudo_ref', 'ref_only')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, auth_kind, auth_client_key)
);

CREATE TABLE IF NOT EXISTS mcp_identity_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_kind text NOT NULL CHECK (auth_kind IN ('oauth', 'admin_token')),
  auth_client_key text NOT NULL,
  subject_id uuid NOT NULL REFERENCES mcp_identity_subjects(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_identity_refs_scope_idx
  ON mcp_identity_refs (owner_user_id, auth_kind, auth_client_key, subject_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_identity_refs_expiry_idx
  ON mcp_identity_refs (expires_at)
  WHERE revoked_at IS NULL;
