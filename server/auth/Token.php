<?php
declare(strict_types=1);

namespace RH\Auth;

/**
 * Participant tokens (architecture doc section 25): 256-bit random,
 * stored server-side only as SHA-256 hashes.
 */
final class Token
{
    public static function generate(): string
    {
        return bin2hex(random_bytes(32));
    }

    public static function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    public static function matches(string $token, string $storedHash): bool
    {
        return $storedHash !== '' && hash_equals($storedHash, self::hash($token));
    }
}
