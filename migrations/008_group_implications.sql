CREATE TABLE IF NOT EXISTS group_implications (
  id bigserial PRIMARY KEY,
  source_group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  implied_group_id bigint NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_group_id, implied_group_id),
  CHECK (source_group_id != implied_group_id)
);

CREATE INDEX IF NOT EXISTS group_implications_source_idx ON group_implications (source_group_id);
CREATE INDEX IF NOT EXISTS group_implications_implied_idx ON group_implications (implied_group_id);
