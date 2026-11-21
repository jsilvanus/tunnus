DROP TABLE IF EXISTS mcp_state;

CREATE TABLE IF NOT EXISTS mcp_state (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  fixed_time_until timestamptz,
  list_locked boolean NOT NULL DEFAULT false,
  commit_list jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
