-- Notification hooks and delivery logs (migrated from Valopankki to central Tunnus event bus)
CREATE TABLE IF NOT EXISTS notification_hooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant text NOT NULL DEFAULT '',
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  secret text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_hooks_tenant_idx ON notification_hooks(tenant, active);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hook_id uuid NOT NULL REFERENCES notification_hooks(id) ON DELETE CASCADE,
  tenant text NOT NULL DEFAULT '',
  event text NOT NULL,
  payload jsonb NOT NULL,
  status_code integer,
  success boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_hook_idx ON notification_deliveries(hook_id, created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_tenant_idx ON notification_deliveries(tenant, created_at);
