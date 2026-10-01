<?php
declare(strict_types=1);

namespace RH\Auth;

use RH\Api\Request;
use RH\Api\Response;
use RH\Session\SessionStore;
use RH\Storage\Database;

/**
 * Resolves a Bearer token into {session, role}.
 * Terminates the request with 401/403 on failure.
 */
final class Guard
{
    public function __construct(
        private readonly Database $db,
        private readonly SessionStore $store
    ) {
    }

    /** @return array{session: array, role: string} */
    public function requireParticipant(Request $req, ?string $target = null): array
    {
        $token = $req->bearer;
        if ($token === null || $token === '') {
            Response::error('missing_token', 'Authorization: Bearer <token> is required', 401);
        }

        $hash = Token::hash($token);
        $stmt = $this->db->pdo()->prepare(
            'SELECT * FROM sessions WHERE host_token_hash = ? OR viewer_token_hash = ?'
        );
        $stmt->execute([$hash, $hash]);
        $row = $stmt->fetch();
        if (!is_array($row)) {
            Response::error('invalid_token', 'Token is not valid', 401);
        }

        $role = hash_equals((string) $row['host_token_hash'], $hash) ? 'host' : 'viewer';
        $session = $this->store->refresh($row);

        // The token must belong to the session addressed by the URL.
        if ($target !== null
            && $target !== $session['id']
            && strcasecmp($target, (string) $session['human_code']) !== 0
        ) {
            Response::error('session_mismatch', 'Token does not belong to this session', 403);
        }

        return ['session' => $session, 'role' => $role];
    }
}
