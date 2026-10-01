<?php
/**
 * Remote Help — backend configuration (example).
 *
 * Copy this file to config/config.php and adjust it.
 * config/config.php is git-ignored and must not be web-accessible.
 */
return [
    'db' => [
        // 'sqlite' (development / simple hosting) or 'mysql' (production)
        'driver' => 'sqlite',
        'sqlite_path' => dirname(__DIR__) . '/storage/data.sqlite',
        'mysql' => [
            'host' => '127.0.0.1',
            'port' => 3306,
            'name' => 'remotehelp',
            'user' => 'remotehelp',
            'pass' => '',
            'charset' => 'utf8mb4',
        ],
    ],

    // How long a fresh session code stays valid while WAITING for a viewer.
    'code_ttl' => 300,

    // Hard lifetime of a session (seconds) from creation.
    'session_ttl' => 3600,

    // Long-poll: max seconds a GET /api/signal request is held open.
    'max_hold' => 20,

    // Long-poll: microseconds between queue checks while a request is held.
    'poll_interval_us' => 300000,

    // Max JSON body size (bytes) for POST /api/signal.
    'max_payload_bytes' => 262144,

    'rate_limits' => [
        'create'    => ['limit' => 10,  'window' => 300],
        'join_ip'   => ['limit' => 20,  'window' => 300],
        'join_code' => ['limit' => 5,   'window' => 300],
        'signal'    => ['limit' => 600, 'window' => 60],
    ],

    // Empty array = no CORS headers (native desktop clients do not need CORS).
    'allowed_origins' => [],
];
