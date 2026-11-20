ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_email_verified_at timestamptz;
UPDATE users SET last_email_verified_at = last_login_at WHERE last_email_verified_at IS NULL AND last_login_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS login_challenges (
  interaction_uid text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_expires_idx ON login_challenges (expires_at);
