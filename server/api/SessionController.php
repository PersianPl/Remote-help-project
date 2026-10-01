<?php
declare(strict_types=1);

namespace RH\Api;

use RH\Auth\Guard;
use RH\Auth\Token;
use RH\Session\JoinConflictException;
use RH\Session\RateLimiter;
use RH\Session\SessionCode;
use RH\Session\SessionState;

/**
 * REST endpoints for the session lifecycle (architecture doc, section 7):
 *
 *   POST   /api/sessions                create session -> host_token + code
 *   GET    /api/sessions/{id}           session info (host or viewer token)
 *   POST   /api/sessions/{id}/join      viewer joins with code -> viewer_token
 *   POST   /api/sessions/{id}/approve   host approves viewer
 *   POST   /api/sessions/{id}/reject    host rejects viewer
 *   POST   /api/sessions/{id}/close     either side closes the session
 *
 * {id} accepts either the internal session id or the human code (583-241).
 */
final class SessionController
{
    public static function create(Request $req): void
    {
        $cfg = config();
        if ($req->invalidJson) {
            Response::error('invalid_json', 'Request body is not valid JSON', 400);
        }
        $limit = $cfg['rate_limits']['create'];
        $rl = self::limiter()->check('create:' . $req->ip(), (int) $limit['limit'], (int) $limit['window']);
        if (!$rl['allowed']) {
            self::rateLimited($rl);
        }

        $created = store()->create();
        Response::json(self::project($created['session'], 'host') + [
            'host_token' => $created['host_token'],
        ], 201);
    }

    public static function show(Request $req, string $target): void
    {
        $auth = (new Guard(database(), store()))->requireParticipant($req, $target);
        Response::json(self::project($auth['session'], $auth['role']));
    }

    public static function transition(Request $req, string $target, string $action): void
    {
        if ($req->invalidJson) {
            Response::error('invalid_json', 'Request body is not valid JSON', 400);
        }

        match ($action) {
            'join' => self::join($req, $target),
            'approve' => self::approve($req, $target),
            'reject' => self::reject($req, $target),
            'close' => self::close($req, $target),
            default => Response::error('not_found', 'Unknown action', 404),
        };
    }

    // ------------------------------------------------------------------ join

    private static function join(Request $req, string $target): void
    {
        $cfg = config();

        $ipLimit = $cfg['rate_limits']['join_ip'];
        $rl = self::limiter()->check('join_ip:' . $req->ip(), (int) $ipLimit['limit'], (int) $ipLimit['window']);
        if (!$rl['allowed']) {
            self::rateLimited($rl);
        }

        $code = SessionCode::normalize($target);
        if ($code === null) {
            Response::error('invalid_code', 'Session code must be 6 digits (e.g. 583-241)', 400);
        }

        // Per-code limiter runs before the lookup so codes cannot be enumerated.
        $codeLimit = $cfg['rate_limits']['join_code'];
        $rl = self::limiter()->check('join_code:' . $code, (int) $codeLimit['limit'], (int) $codeLimit['window']);
        if (!$rl['allowed']) {
            self::rateLimited($rl);
        }

        $session = store()->find($code);
        if ($session === null) {
            Response::error('unknown_session', 'No session matches this code', 404);
        }
        $session = store()->refresh($session);

        if ($session['state'] === SessionState::EXPIRED) {
            Response::error('session_expired', 'This session has expired', 410);
        }
        if ($session['state'] === SessionState::CLOSED) {
            Response::error('session_closed', 'This session is closed', 409, ['state' => $session['state']]);
        }
        if ($session['viewer_token_hash'] !== null && $session['viewer_token_hash'] !== '') {
            Response::error('already_joined', 'A viewer has already joined this session', 409);
        }
        if ($session['state'] !== SessionState::WAITING) {
            Response::error('not_joinable', 'Session is not accepting viewers', 409, ['state' => $session['state']]);
        }

        $viewerToken = Token::generate();
        try {
            $session = store()->join($session['id'], $viewerToken);
        } catch (JoinConflictException) {
            // Another viewer won the race between our check and the write.
            Response::error('already_joined', 'A viewer has already joined this session', 409);
        }

        Response::json(self::project($session, 'viewer') + [
            'viewer_token' => $viewerToken,
        ]);
    }

    // --------------------------------------------------------------- approve

    private static function approve(Request $req, string $target): void
    {
        $auth = (new Guard(database(), store()))->requireParticipant($req, $target);
        if ($auth['role'] !== 'host') {
            Response::error('forbidden', 'Only the host can approve a viewer', 403);
        }
        $session = $auth['session'];
        if ($session['state'] === SessionState::EXPIRED) {
            Response::error('session_expired', 'This session has expired', 410);
        }
        if ($session['state'] !== SessionState::JOIN_REQUESTED) {
            Response::error('invalid_state', 'No viewer is waiting for approval', 409, ['state' => $session['state']]);
        }
        $session = store()->transition($session['id'], SessionState::APPROVED, 'session.approved');
        Response::json(self::project($session, 'host'));
    }

    private static function reject(Request $req, string $target): void
    {
        $auth = (new Guard(database(), store()))->requireParticipant($req, $target);
        if ($auth['role'] !== 'host') {
            Response::error('forbidden', 'Only the host can reject a viewer', 403);
        }
        $session = $auth['session'];
        if ($session['state'] !== SessionState::JOIN_REQUESTED) {
            Response::error('invalid_state', 'No viewer is waiting for rejection', 409, ['state' => $session['state']]);
        }
        $session = store()->transition($session['id'], SessionState::CLOSED, 'session.closed', ['reason' => 'rejected']);
        Response::json(self::project($session, 'host'));
    }

    private static function close(Request $req, string $target): void
    {
        $auth = (new Guard(database(), store()))->requireParticipant($req, $target);
        $session = $auth['session'];
        if ($session['state'] !== SessionState::CLOSED && $session['state'] !== SessionState::EXPIRED) {
            $session = store()->transition($session['id'], SessionState::CLOSED, 'session.closed', ['reason' => 'closed']);
        }
        // Closing an already-final session is an idempotent no-op.
        Response::json(self::project($session, $auth['role']));
    }

    // --------------------------------------------------------------- helpers

    private static function limiter(): RateLimiter
    {
        return new RateLimiter(database(), database()->driver());
    }

    private static function rateLimited(array $rl): never
    {
        Response::error('rate_limited', 'Too many attempts, slow down', 429, [
            'retry_after' => $rl['retry_after'],
        ]);
    }

    /** Public session shape — never exposes token hashes. */
    public static function project(array $session, string $role): array
    {
        return [
            'session_id' => $session['id'],
            'code' => $session['human_code'],
            'state' => $session['state'],
            'role' => $role,
            'created_at' => (int) $session['created_at'],
            'code_expires_at' => (int) $session['code_expires_at'],
            'expires_at' => (int) $session['expires_at'],
        ];
    }
}

