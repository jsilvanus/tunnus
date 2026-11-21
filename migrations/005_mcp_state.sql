CREATE TABLE IF NOT EXISTS mcp_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fixed_time_until timestamptz,
  list_locked boolean NOT NULL DEFAULT false,
  commit_list jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO mcp_state (id, fixed_time_until, list_locked, commit_list)
VALUES (1, NULL, false, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;
