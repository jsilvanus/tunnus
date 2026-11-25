CREATE TABLE IF NOT EXISTS discovery_services (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  type text NOT NULL CHECK (type ~ '^[a-z0-9_-]{1,32}$'),
  venue text NOT NULL CHECK (venue ~ '^[a-z0-9_-]{1,32}$'),
  endpoint_url text NOT NULL CHECK (endpoint_url ~ '^https?://'),
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
