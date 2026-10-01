<?php
declare(strict_types=1);

namespace RH\Session;

/**
 * Session states — mirrors the state machine in architecture doc section 37.
 *
 * The ALLOWED table below is the single source of truth for legal
 * transitions (prompt stage 5). Server code must never move a session
 * outside this table; clients can only trigger transitions through
 * validated endpoints, never by raw messages.
 *
 * States folded into existing ones (documented decision):
 *   REJECTED -> CLOSED with payload.reason = "rejected"
 *   FAILED   -> CLOSED with payload.reason = "..." (client-driven)
 *   CLOSING  -> CLOSED directly (stateless shared hosting: one atomic step)
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

    /** @var array<string, list<string>> */
    private const ALLOWED = [
        self::WAITING => [self::JOIN_REQUESTED, self::CLOSED, self::EXPIRED],
        self::JOIN_REQUESTED => [self::APPROVED, self::CLOSED, self::EXPIRED],
        self::APPROVED => [self::NEGOTIATING, self::CLOSED, self::EXPIRED],
        self::NEGOTIATING => [self::CONNECTED, self::CLOSED, self::EXPIRED],
        self::CONNECTED => [self::CLOSED, self::EXPIRED],
        self::CLOSED => [],
        self::EXPIRED => [],
    ];

    public static function canTransition(string $from, string $to): bool
    {
        return in_array($to, self::ALLOWED[$from] ?? [], true);
    }

    /** @return list<string> */
    public static function allowedTargets(string $from): array
    {
        return self::ALLOWED[$from] ?? [];
    }

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

