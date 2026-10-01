<?php
declare(strict_types=1);

namespace RH\Signaling;

use RH\Storage\Database;

/**
 * Persistent signaling message queue (architecture doc section 12).
 *
 * Global AUTO_INCREMENT ids act as per-session cursors: clients remember
 * the last id they saw for their own session and pass it as ?since=.
 */
final class SignalStore
{
    public function __construct(private readonly Database $db)
    {
    }

    /** @return int new message id */
    public function append(string $sessionId, string $sender, string $name, array $payload): int
    {
        $stmt = $this->db->pdo()->prepare(
            'INSERT INTO messages (session_id, sender, name, payload, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $sessionId,
            $sender,
            $name,
            json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            now(),
        ]);
        return (int) $this->db->pdo()->lastInsertId();
    }

    /** @return list<array{id: int, sender: string, name: string, payload: array, ts: int}> */
    public function fetch(string $sessionId, int $since, int $limit = 200): array
    {
        $limit = max(1, min(500, $limit));
        $stmt = $this->db->pdo()->prepare(
            'SELECT id, sender, name, payload, created_at FROM messages'
            . ' WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ' . $limit
        );
        $stmt->execute([$sessionId, max(0, $since)]);

        $messages = [];
        foreach ($stmt->fetchAll() as $row) {
            $payload = json_decode((string) $row['payload'], true);
            $messages[] = [
                'id' => (int) $row['id'],
                'sender' => (string) $row['sender'],
                'name' => (string) $row['name'],
                'payload' => is_array($payload) ? $payload : [],
                'ts' => (int) $row['created_at'],
            ];
        }
        return $messages;
    }
}
