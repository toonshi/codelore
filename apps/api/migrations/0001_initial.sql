-- LinkedIn OAuth connections. Access tokens are encrypted before storage.
CREATE TABLE IF NOT EXISTS linkedin_connections (
  id TEXT PRIMARY KEY,
  member_urn TEXT NOT NULL UNIQUE,
  encrypted_access_token TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One-time OAuth state values. Only a hash is stored, never the raw value.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at
  ON oauth_states (expires_at);
