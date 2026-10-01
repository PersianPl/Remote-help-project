<?php
declare(strict_types=1);

/**
 * Helper: performs one long-poll GET and prints {elapsed, raw} as JSON.
 * Spawned by run_tests.php to test mid-poll message delivery.
 *
 * Usage: php long_poll.php <url> <bearer-token>
 */

$url = $argv[1] ?? '';
$token = $argv[2] ?? '';

$context = stream_context_create([
    'http' => [
        'method' => 'GET',
        'header' => 'Authorization: Bearer ' . $token . "\r\n",
        'timeout' => 30.0,
        'ignore_errors' => true,
    ],
]);

$start = microtime(true);
$raw = @file_get_contents($url, false, $context);

echo json_encode([
    'elapsed' => microtime(true) - $start,
    'raw' => (string) $raw,
]);
