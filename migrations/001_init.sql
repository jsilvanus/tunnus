CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS groups (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS oidc_payloads (
  type text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  grant_id text,
  uid text,
  user_code text,
  expires_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS oidc_payloads_grant_id_idx ON oidc_payloads (grant_id);
CREATE INDEX IF NOT EXISTS oidc_payloads_uid_idx ON oidc_payloads (uid);
CREATE INDEX IF NOT EXISTS oidc_payloads_user_code_idx ON oidc_payloads (user_code);
CREATE INDEX IF NOT EXISTS oidc_payloads_expires_idx ON oidc_payloads (expires_at);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid text PRIMARY KEY,
  alg text NOT NULL,
  private_jwk text NOT NULL,
  public_jwk jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('next', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz
);
