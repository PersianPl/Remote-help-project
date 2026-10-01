<?php
declare(strict_types=1);

namespace RH\Session;

/**
 * Human session code (architecture doc section 8): short, temporary,
 * CSPRNG-generated, one-time-join. Lookup is rate-limited server-side.
 */
final class SessionCode
{
    public static function generate(): string
    {
        $value = random_int(0, 999999);
        return sprintf('%03d-%03d', intdiv($value, 1000), $value % 1000);
    }

    /**
     * Accepts "583-241", "583241", "583 241"... returns canonical form or null.
     */
    public static function normalize(string $input): ?string
    {
        $digits = preg_replace('/\D+/', '', $input) ?? '';
        if (strlen($digits) !== 6) {
            return null;
        }
        return substr($digits, 0, 3) . '-' . substr($digits, 3);
    }
}
