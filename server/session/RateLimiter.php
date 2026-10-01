<?php
declare(strict_types=1);

namespace RH\Session;

use RH\Storage\Database;

/**
 * Database-backed fixed-window rate limiter (architecture doc section 50).
 * No background processes needed — windows roll over lazily on access.
 */
final class RateLimiter
{
    public function __construct(
        private readonly Database $db,
        private readonly string $driver = 'sqlite'
    ) {
    }

    /** @return array{allowed: bool, retry_after: int} */
    public function check(string $bucket, int $limit, int $windowSeconds): array
    {
        $pdo = $this->db->pdo();
        $now = now();

        $stmt = $pdo->prepare('SELECT window_start, cnt FROM rate_limits WHERE bucket = ?');
        $stmt->execute([$bucket]);
        $row = $stmt->fetch();

        if (is_array($row) && ($now - (int) $row['window_start']) < $windowSeconds) {
            if ((int) $row['cnt'] >= $limit) {
                return [
                    'allowed' => false,
                    'retry_after' => max(1, $windowSeconds - ($now - (int) $row['window_start'])),
                ];
            }
            $pdo->prepare('UPDATE rate_limits SET cnt = cnt + 1 WHERE bucket = ?')->execute([$bucket]);
            return ['allowed' => true, 'retry_after' => 0];
        }

        $sql = $this->driver === 'mysql'
            ? 'INSERT INTO rate_limits (bucket, window_start, cnt) VALUES (?, ?, 1) '
                . 'ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), cnt = 1'
            : 'INSERT INTO rate_limits (bucket, window_start, cnt) VALUES (?, ?, 1) '
                . 'ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, cnt = 1';
        $pdo->prepare($sql)->execute([$bucket, $now]);

        return ['allowed' => true, 'retry_after' => 0];
    }
}
