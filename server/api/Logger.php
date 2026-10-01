<?php
declare(strict_types=1);

namespace RH\Api;

/**
 * Level-based structured logger (stage 13).
 *
 * - levels: debug(10) < info(20) < warn(30) < error(40); threshold via config.log_level
 * - sink: config.log_file when set (append), otherwise PHP error_log
 * - values whose keys look sensitive are masked — tokens, secrets,
 *   passwords, credentials and human session codes never reach the log
 */
final class Logger
{
    private const LEVELS = ['debug' => 10, 'info' => 20, 'warn' => 30, 'error' => 40];

    public static function log(string $level, string $event, array $context = []): void
    {
        $cfg = config();
        $threshold = self::LEVELS[$cfg['log_level'] ?? 'info'] ?? 20;
        $rank = self::LEVELS[$level] ?? 20;
        if ($rank < $threshold) {
            return;
        }

        $line = json_encode([
            'ts' => date('c'),
            'level' => $level,
            'event' => $event,
            'context' => self::mask($context),
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $file = $cfg['log_file'] ?? '';
        if (is_string($file) && $file !== '') {
            @file_put_contents($file, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
        } else {
            error_log((string) $line);
        }
    }

    public static function debug(string $event, array $context = []): void
    {
        self::log('debug', $event, $context);
    }

    public static function info(string $event, array $context = []): void
    {
        self::log('info', $event, $context);
    }

    public static function warn(string $event, array $context = []): void
    {
        self::log('warn', $event, $context);
    }

    public static function error(string $event, array $context = []): void
    {
        self::log('error', $event, $context);
    }

    private static function mask(array $context): array
    {
        $out = [];
        foreach ($context as $key => $value) {
            if (is_string($key)
                && preg_match('/token|secret|password|passphrase|authorization|credential|human_code/i', $key) === 1
            ) {
                $out[$key] = '[redacted]';
            } elseif (is_array($value)) {
                $out[$key] = self::mask($value);
            } else {
                $out[$key] = $value;
            }
        }
        return $out;
    }
}
