-- Remote Help — MySQL/MariaDB schema (production)
CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) NOT NULL PRIMARY KEY,
    human_code VARCHAR(11) NOT NULL,
    state VARCHAR(20) NOT NULL,
    host_token_hash CHAR(64) NOT NULL,
    viewer_token_hash CHAR(64) NULL,
    created_at INT UNSIGNED NOT NULL,
    code_expires_at INT UNSIGNED NOT NULL,
    expires_at INT UNSIGNED NOT NULL,
    updated_at INT UNSIGNED NOT NULL,
    closed_at INT UNSIGNED NULL,
    UNIQUE KEY uq_sessions_human_code (human_code),
    KEY idx_sessions_viewer_token (viewer_token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    sender VARCHAR(10) NOT NULL,
    name VARCHAR(48) NOT NULL,
    payload MEDIUMTEXT NULL,
    created_at INT UNSIGNED NOT NULL,
    KEY idx_messages_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket VARCHAR(64) NOT NULL PRIMARY KEY,
    window_start INT UNSIGNED NOT NULL,
    cnt INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
