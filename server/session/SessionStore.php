<?php
declare(strict_types=1);

namespace RH\Session;

use PDO;
use RH\Auth\Token;
use RH\Signaling\SignalStore;
use RH\Storage\Database;
use RuntimeException;

/**
 * Session lifecycle + state machine (architecture doc sections 37 and 55).
 *
 * Expiry is lazy (shared hosting has no background daemon): every access
 * through refresh() transitions overdue sessions to EXPIRED.
 */
final class SessionStore
{
    public function __construct(
        private readonly Database $db,
        private readonly array $config,
        private readonly SignalStore $signals
    ) {
    }

    /** @return array{session: array, host_token: string} */
    public function create(): array
    {
        $now = now();
        $this->cleanup($now);

        $hostToken = Token::generate();
        $hostHash = Token::hash($hostToken);

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $id = self::uuid4();
            $code = SessionCode::generate();
            try {
                $stmt = $this->db->pdo()->prepare(
                    'INSERT INTO sessions (id, human_code, state, host_token_hash, created_at,'
                    . ' code_expires_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                );
                $stmt->execute([
                    $id,
                    $code,
                    SessionState::WAITING,
                    $hostHash,
                    $now,
                    $now + (int) $this->config['code_ttl'],
                    $now + (int) $this->config['session_ttl'],
                    $now,
                ]);
                return ['session' => $this->find($id), 'host_token' => $hostToken];
            } catch (PDOException $e) {
                if (!str_contains($e->getMessage(), 'UNIQUE') && !str_contains($e->getMessage(), 'Duplicate')) {
                    throw $e;
                }
                // Human code collision — regenerate with a fresh id.
            }
        }

        throw new RuntimeException('Could not allocate a unique session code');
    }

    public function find(string $idOrCode): ?array
    {
        $pdo = $this->db->pdo();

        $stmt = $pdo->prepare('SELECT * FROM sessions WHERE id = ?');
        $stmt->execute([$idOrCode]);
        $row = $stmt->fetch();
        if (is_array($row)) {
            return $row;
        }

        $code = SessionCode::normalize($idOrCode);
        if ($code === null) {
            return null;
        }
        $stmt = $pdo->prepare('SELECT * FROM sessions WHERE human_code = ?');
        $stmt->execute([$code]);
        $row = $stmt->fetch();
        return is_array($row) ? $row : null;
    }

    /** Applies lazy expiry, then returns the fresh row. */
    public function refresh(array $session): array
    {
        if (SessionState::isFinal($session['state'])) {
            return $session;
        }
        $now = now();
        $overdue = $now >= (int) $session['expires_at']
            || ($session['state'] === SessionState::WAITING
                && $now >= (int) $session['code_expires_at']);
        if (!$overdue) {
            return $session;
        }
        return $this->transition($session['id'], SessionState::EXPIRED, 'session.expired') ?? $session;
    }

    /**
     * One-time viewer join (architecture doc: one-time join + host approval).
     *
     * @throws JoinConflictException when the session left WAITING in the meantime
     */
    public function join(string $sessionId, string $viewerToken): array
    {
        $stmt = $this->db->pdo()->prepare(
            'UPDATE sessions SET viewer_token_hash = ?, state = ?, updated_at = ? WHERE id = ? AND state = ?'
        );
        $stmt->execute([
            Token::hash($viewerToken),
            SessionState::JOIN_REQUESTED,
            now(),
            $sessionId,
            SessionState::WAITING,
        ]);
        if ($stmt->rowCount() === 0) {
            throw new JoinConflictException('Session is no longer waiting for a viewer');
        }
        $this->signals->append($sessionId, 'system', 'session.join_requested', []);
        return $this->find($sessionId);
    }

    /**
     * Transitions to $to and optionally enqueues a system message so the
     * other side learns about it through the same signal queue.
     */
    public function transition(string $sessionId, string $to, ?string $systemMessage = null, ?array $payload = null): ?array
    {
        $now = now();
        $stmt = $this->db->pdo()->prepare(
            'UPDATE sessions SET state = ?, updated_at = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?'
        );
        $stmt->execute([$to, $now, SessionState::isFinal($to) ? $now : null, $sessionId]);

        if ($systemMessage !== null) {
            $this->signals->append($sessionId, 'system', $systemMessage, $payload ?? []);
        }
        return $this->find($sessionId);
    }

    /** Opportunistic housekeeping — runs on session creation only. */
    private function cleanup(int $now): void
    {
        $pdo = $this->db->pdo();
        $cutoff = $now - 86400;
        $pdo->prepare('DELETE FROM sessions WHERE closed_at IS NOT NULL AND closed_at < ?')
            ->execute([$cutoff]);
        $pdo->exec('DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)');
        $pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')
            ->execute([$cutoff]);
    }

    private static function uuid4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
