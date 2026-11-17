CREATE TABLE IF NOT EXISTS email_codes (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  code_enc text NOT NULL,
  link_token_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signup', 'login')),
  interaction_uid text NOT NULL,
  ip text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS email_codes_uid_idx ON email_codes (interaction_uid);
CREATE INDEX IF NOT EXISTS email_codes_email_created_idx ON email_codes (email, created_at);
CREATE INDEX IF NOT EXISTS email_codes_ip_created_idx ON email_codes (ip, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip text,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action, at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS inactive_warned_at timestamptz;
