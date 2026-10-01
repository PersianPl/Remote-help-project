<?php
declare(strict_types=1);

namespace RH\Session;

/**
 * Session states — mirrors the state machine in architecture doc section 37.
 */
final class SessionState
{
    public const WAITING = 'waiting';
    public const JOIN_REQUESTED = 'join_requested';
    public const APPROVED = 'approved';
    public const NEGOTIATING = 'negotiating';
    public const CONNECTED = 'connected';
    public const CLOSED = 'closed';
    public const EXPIRED = 'expired';

    /** States in which signaling messages (offer/answer/ice/status) are allowed. */
    public static function signalingAllowed(string $state): bool
    {
        return in_array($state, [self::APPROVED, self::NEGOTIATING, self::CONNECTED], true);
    }

    public static function isFinal(string $state): bool
    {
        return $state === self::CLOSED || $state === self::EXPIRED;
    }
}
