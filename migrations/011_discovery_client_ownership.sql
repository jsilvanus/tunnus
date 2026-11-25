ALTER TABLE discovery_services
  ADD COLUMN IF NOT EXISTS owner_client_id text REFERENCES oidc_clients(client_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS discovery_services_owner_client_idx ON discovery_services(owner_client_id);
