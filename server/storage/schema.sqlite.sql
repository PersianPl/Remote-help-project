-- Remote Help — SQLite schema (development / simple hosting)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    human_code TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    host_token_hash TEXT NOT NULL,
    viewer_token_hash TEXT,
    created_at INTEGER NOT NULL,
    code_expires_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    cnt INTEGER NOT NULL
);
