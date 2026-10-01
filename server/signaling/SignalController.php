<?php
declare(strict_types=1);

namespace RH\Signaling;

use RH\Api\Request;
use RH\Api\Response;
use RH\Auth\Guard;
use RH\Session\RateLimiter;
use RH\Session\SessionState;

/**
 * Long-polling signaling transport (architecture doc sections 67.2-67.3).
 *
 *   GET  /api/signal?since=N&hold=S  — held up to max_hold seconds
 *   POST /api/signal {name, payload} — enqueue for the other participant
 *
 * Signal names (protocol v1): offer, answer, ice, status.
 * System messages (session.join_requested / session.approved /
 * session.closed / session.expired) are enqueued by SessionStore so both
 * sides learn about lifecycle changes through the same queue.
 */
final class SignalController
{
    private const NAMES = ['offer', 'answer', 'ice', 'status'];

    public static function poll(Request $req): void
    {
        $auth = (new Guard(database(), store()))->requireParticipant($req);
        $cfg = config();
        $sessionId = $auth['session']['id'];
        $since = $req->queryInt('since', 0);
        $hold = max(0.0, min(
            $req->queryFloat('hold', (float) $cfg['max_hold']),
            (float) $cfg['max_hold']
        ));

        // Keep proxies from buffering the held response.
        header('X-Accel-Buffering: no');

        $start = microtime(true);
        $messages = [];
        while (true) {
            $messages = signals()->fetch($sessionId, $since);
            if ($messages !== [] || (microtime(true) - $start) >= $hold) {
                break;
            }
            if (connection_aborted()) {
                break;
            }
            usleep((int) $cfg['poll_interval_us']);
        }

        $latest = store()->find($sessionId);
        Response::json([
            'messages' => $messages,
            'state' => $latest['state'] ?? $auth['session']['state'],
            'now' => time(),
        ]);
    }

    public static function send(Request $req): void
    {
        $cfg = config();

        if ($req->invalidJson) {
            Response::error('invalid_json', 'Request body is not valid JSON', 400);
        }
        if (strlen($req->raw) > (int) $cfg['max_payload_bytes']) {
            Response::error('payload_too_large', 'Signal payload exceeds the size limit', 413);
        }

        $auth = (new Guard(database(), store()))->requireParticipant($req);
        $session = $auth['session'];
        $role = $auth['role'];

        $name = $req->body['name'] ?? null;
        if (!is_string($name) || !in_array($name, self::NAMES, true)) {
            Response::error('unknown_signal_name', 'name must be one of: ' . implode(', ', self::NAMES), 400);
        }
        $payload = $req->body['payload'] ?? [];
        if (!is_array($payload)) {
            Response::error('invalid_payload', 'payload must be a JSON object', 400);
        }

        $limit = $cfg['rate_limits']['signal'];
        $rl = (new RateLimiter(database(), database()->driver()))->check(
            'signal:' . $session['id'],
            (int) $limit['limit'],
            (int) $limit['window']
        );
        if (!$rl['allowed']) {
            Response::error('rate_limited', 'Too many signal messages', 429, ['retry_after' => $rl['retry_after']]);
        }

        $state = $session['state'];
        if ($state === SessionState::EXPIRED) {
            Response::error('session_expired', 'This session has expired', 410);
        }
        if ($state === SessionState::CLOSED) {
            Response::error('session_closed', 'This session is closed', 409);
        }
        if (!SessionState::signalingAllowed($state)) {
            Response::error('state_not_allowed', 'Signaling is not allowed in this state', 409, ['state' => $state]);
        }

        $id = signals()->append($session['id'], $role, $name, $payload);

        // Advance the state machine based on the signal itself.
        if (($name === 'offer' || $name === 'answer') && $state === SessionState::APPROVED) {
            store()->transition($session['id'], SessionState::NEGOTIATING);
        }
        if ($name === 'status'
            && ($payload['state'] ?? '') === 'connected'
            && in_array($state, [SessionState::APPROVED, SessionState::NEGOTIATING], true)
        ) {
            store()->transition($session['id'], SessionState::CONNECTED);
        }

        Response::json(['id' => $id], 201);
    }
}
