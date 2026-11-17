CREATE TABLE IF NOT EXISTS admin_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_tokens_user_idx ON admin_tokens (user_id);
ALTER TABLE signing_keys ADD COLUMN IF NOT EXISTS published_until timestamptz;
CREATE INDEX IF NOT EXISTS oidc_payloads_account_idx ON oidc_payloads ((payload->>'accountId'));
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_user_id, id);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_type, target_id, id);
