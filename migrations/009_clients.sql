CREATE TABLE IF NOT EXISTS oidc_clients (
  client_id text PRIMARY KEY
    CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  metadata jsonb NOT NULL,
  secret_enc text,
  secret_set_at timestamptz,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('file', 'api')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oidc_client_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO oidc_client_state (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS oidc_payloads_client_idx ON oidc_payloads ((payload->>'clientId'));
