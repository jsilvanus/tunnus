ALTER TABLE users ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activates_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disables_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE INDEX IF NOT EXISTS users_lifecycle_idx ON users (status, activates_at, disables_at);
