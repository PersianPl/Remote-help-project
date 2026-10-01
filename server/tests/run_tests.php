<?php
declare(strict_types=1);

/**
 * Remote Help — integration test suite.
 *
 * Boots the real HTTP server (php -S) against an isolated SQLite database
 * and exercises the full session + signaling flow over HTTP.
 *
 * Usage:  php server/tests/run_tests.php
 */

$serverDir = dirname(__DIR__);

// ---------------------------------------------------------- temp environment
$tempDir = sys_get_temp_dir() . '/rh_test_' . getmypid();
if (!is_dir($tempDir)) {
    mkdir($tempDir, 0775, true);
}
$configFile = $tempDir . '/config.php';
$testConfig = [
    'db' => [
        'driver' => 'sqlite',
        'sqlite_path' => $tempDir . '/test.sqlite',
        'mysql' => [],
    ],
    'code_ttl' => 2,               // keeps the expiry test fast
    'session_ttl' => 3600,
    'max_hold' => 5,
    'poll_interval_us' => 200000,
    'max_payload_bytes' => 262144,
    'rate_limits' => [
        'create'    => ['limit' => 50, 'window' => 300],
        'join_ip'   => ['limit' => 100, 'window' => 300],
        'join_code' => ['limit' => 3, 'window' => 60],
        'signal'    => ['limit' => 1000, 'window' => 60],
    ],
    'allowed_origins' => [],
];
file_put_contents($configFile, "<?php\nreturn " . var_export($testConfig, true) . ";\n");

// ------------------------------------------------------------- start server
$host = '127.0.0.1';
$port = 8100 + (getmypid() % 800);
$base = "http://{$host}:{$port}";

$env = array_merge(getenv(), [
    'RH_CONFIG' => $configFile,
    'PHP_CLI_SERVER_WORKERS' => '4', // enables concurrency tests where supported
]);

$serverProcess = proc_open(
    [PHP_BINARY, '-d', 'display_errors=1', '-S', "{$host}:{$port}", '-t',
        $serverDir . '/public', $serverDir . '/public/router.php'],
    [
        0 => ['pipe', 'r'],
        1 => ['file', $tempDir . '/server.log', 'a'],
        2 => ['file', $tempDir . '/server.log', 'a'],
    ],
    $serverPipes,
    $serverDir,
    $env
);

if (!is_resource($serverProcess)) {
    fwrite(STDERR, "FATAL: failed to start the test server\n");
    exit(1);
}

register_shutdown_function(static function () use ($serverProcess, $tempDir): void {
    proc_terminate($serverProcess);
    usleep(200000);
    foreach (glob($tempDir . '/*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($tempDir);
});

// --------------------------------------------------------------- http helpers
/**
 * @param array|string|null $body array = JSON-encoded, string = sent raw
 * @return array{status: int, json: mixed, elapsed: float, raw: string}
 */
function req(string $method, string $path, array|string|null $body = null, ?string $token = null, float $timeout = 30.0): array
{
    global $base;
    $headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
    if ($token !== null && $token !== '') {
        $headers .= 'Authorization: Bearer ' . $token . "\r\n";
    }
    $context = stream_context_create([
        'http' => [
            'method' => $method,
            'header' => $headers,
            'content' => is_array($body) ? (string) json_encode($body) : (string) $body,
            'timeout' => $timeout,
            'ignore_errors' => true,
        ],
    ]);

    $start = microtime(true);
    $raw = @file_get_contents($base . $path, false, $context);
    $elapsed = microtime(true) - $start;

    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m) === 1) {
            $status = (int) $m[1];
        }
    }

    return [
        'status' => $status,
        'json' => json_decode((string) $raw, true),
        'elapsed' => $elapsed,
        'raw' => (string) $raw,
    ];
}

$GLOBALS['pass'] = 0;
$GLOBALS['fail'] = 0;

function check(bool $condition, string $name, string $detail = ''): void
{
    if ($condition) {
        $GLOBALS['pass']++;
        echo "  [PASS] {$name}\n";
    } else {
        $GLOBALS['fail']++;
        echo "  [FAIL] {$name}" . ($detail !== '' ? " -- {$detail}" : '') . "\n";
    }
}

function section(string $title): void
{
    echo "\n== {$title}\n";
}

// Wait until the server answers before running any scenario.
$up = false;
for ($i = 0; $i < 50; $i++) {
    if (req('GET', '/api/health', null, null, 1.0)['status'] === 200) {
        $up = true;
        break;
    }
    usleep(100000);
}
if (!$up) {
    fwrite(STDERR, "FATAL: server did not become healthy. Log:\n");
    fwrite(STDERR, (string) @file_get_contents($tempDir . '/server.log'));
    exit(1);
}

section('Health + long-poll hold');
$health = req('GET', '/api/health');
check($health['status'] === 200 && ($health['json']['ok'] ?? false) === true, 'health responds ok');

$hold = req('GET', '/api/health?hold=2');
check($hold['elapsed'] >= 1.9, 'hold=2 keeps the connection ~2s', sprintf('%.2fs', $hold['elapsed']));
check(($hold['json']['held'] ?? 0) >= 1.9, 'server reports actual held duration', var_export($hold['json']['held'] ?? null, true));

section('Session lifecycle');
$created = req('POST', '/api/sessions', []);
check($created['status'] === 201, 'create session -> 201', $created['raw']);
$hostToken = (string) ($created['json']['host_token'] ?? '');
$sessionId = (string) ($created['json']['session_id'] ?? '');
$code = (string) ($created['json']['code'] ?? '');
check(strlen($hostToken) === 64, 'host token is 64 hex chars');
check(preg_match('/^\d{3}-\d{3}$/', $code) === 1, 'human code has 123-456 format', $code);
check(($created['json']['state'] ?? '') === 'waiting', 'initial state = waiting');
check(($created['json']['role'] ?? '') === 'host', 'create response role = host');

$badJoin = req('POST', '/api/sessions/999-998/join', []);
check($badJoin['status'] === 404, 'join unknown code -> 404', $badJoin['raw']);

$joined = req('POST', '/api/sessions/' . $code . '/join', []);
check($joined['status'] === 200, 'viewer joins by code -> 200', $joined['raw']);
$viewerToken = (string) ($joined['json']['viewer_token'] ?? '');
check(strlen($viewerToken) === 64, 'viewer token issued');
check(($joined['json']['state'] ?? '') === 'join_requested', 'state = join_requested');

$again = req('POST', '/api/sessions/' . $code . '/join', []);
check($again['status'] === 409, 'second viewer rejected -> 409', $again['raw']);

section('Authentication + authorization');
check(req('GET', '/api/signal?hold=0')['status'] === 401, 'signal without token -> 401');
check(req('GET', '/api/signal?hold=0', null, 'deadbeef')['status'] === 401, 'garbage token -> 401');
$viewerApprove = req('POST', '/api/sessions/' . $sessionId . '/approve', [], $viewerToken);
check($viewerApprove['status'] === 403, 'viewer cannot approve -> 403', $viewerApprove['raw']);
$mismatch = req('GET', '/api/sessions/00000000-0000-4000-8000-000000000000', null, $hostToken);
check($mismatch['status'] === 403, 'valid token + foreign session id -> 403', $mismatch['raw']);

section('Signaling before approval is blocked');
$early = req('POST', '/api/signal', ['name' => 'ice', 'payload' => ['candidate' => 'x']], $viewerToken);
check($early['status'] === 409, 'viewer signal before approval -> 409', $early['raw']);

$hostPoll = req('GET', '/api/signal?since=0&hold=1', null, $hostToken);
$hostNames = array_column($hostPoll['json']['messages'] ?? [], 'name');
check(in_array('session.join_requested', $hostNames, true), 'host learns that a viewer joined', json_encode($hostNames));
$lastId = 0;
foreach (($hostPoll['json']['messages'] ?? []) as $message) {
    $lastId = max($lastId, (int) $message['id']);
}

section('Approval + WebRTC signal flow');
$approved = req('POST', '/api/sessions/' . $sessionId . '/approve', [], $hostToken);
check($approved['status'] === 200 && ($approved['json']['state'] ?? '') === 'approved',
    'host approves -> approved', $approved['raw']);

$viewerPoll = req('GET', '/api/signal?since=0&hold=1', null, $viewerToken);
$viewerNames = array_column($viewerPoll['json']['messages'] ?? [], 'name');
check(in_array('session.approved', $viewerNames, true), 'viewer learns about the approval', json_encode($viewerNames));

$offer = req('POST', '/api/signal', ['name' => 'offer', 'payload' => ['sdp' => 'v=0 test']], $hostToken);
check($offer['status'] === 201, 'host posts offer -> 201', $offer['raw']);

$state = req('GET', '/api/sessions/' . $sessionId, null, $hostToken);
check(($state['json']['state'] ?? '') === 'negotiating', 'state advanced to negotiating', $state['raw']);

$answer = req('POST', '/api/signal', ['name' => 'answer', 'payload' => ['sdp' => 'v=0 reply']], $viewerToken);
check($answer['status'] === 201, 'viewer posts answer -> 201', $answer['raw']);
$ice = req('POST', '/api/signal', ['name' => 'ice', 'payload' => ['candidate' => 'c1']], $viewerToken);
check($ice['status'] === 201, 'viewer posts ice -> 201', $ice['raw']);

$hostSince = req('GET', '/api/signal?since=' . $lastId . '&hold=1', null, $hostToken);
$sinceNames = array_column($hostSince['json']['messages'] ?? [], 'name');
check(in_array('answer', $sinceNames, true) && in_array('ice', $sinceNames, true),
    'host receives answer + ice via ?since cursor', json_encode($sinceNames));
foreach (($hostSince['json']['messages'] ?? []) as $message) {
    $lastId = max($lastId, (int) $message['id']);
}

$status = req('POST', '/api/signal', ['name' => 'status', 'payload' => ['state' => 'connected']], $viewerToken);
check($status['status'] === 201, 'status connected -> 201', $status['raw']);
$state2 = req('GET', '/api/sessions/' . $sessionId, null, $hostToken);
check(($state2['json']['state'] ?? '') === 'connected', 'state = connected', $state2['raw']);

section('Long-poll behavior');
$empty = req('GET', '/api/signal?since=999999&hold=1', null, $hostToken, 10.0);
check($empty['status'] === 200 && ($empty['json']['messages'] ?? []) === [], 'empty queue returns []');
check($empty['elapsed'] >= 0.9, 'empty poll is held ~1s before returning', sprintf('%.2fs', $empty['elapsed']));

section('Mid-poll delivery (cross-process)');
// Drain first so the helper starts from a truly empty queue cursor.
$drainForMid = req('GET', '/api/signal?since=' . $lastId . '&hold=0', null, $hostToken);
foreach (($drainForMid['json']['messages'] ?? []) as $message) {
    $lastId = max($lastId, (int) $message['id']);
}

// The built-in server may be single-threaded (e.g. on Windows), so we
// start a SECOND server instance sharing the same SQLite database. This
// reproduces a multi-process production webserver: one process holds the
// poll, another process writes the message.
$helper = __DIR__ . '/helpers/long_poll.php';
$port2 = $port + 1;
$server2 = proc_open(
    [PHP_BINARY, '-d', 'display_errors=1', '-S', "{$host}:{$port2}", '-t',
        $serverDir . '/public', $serverDir . '/public/router.php'],
    [
        0 => ['pipe', 'r'],
        1 => ['file', $tempDir . '/server2.log', 'a'],
        2 => ['file', $tempDir . '/server2.log', 'a'],
    ],
    $pipes2,
    $serverDir,
    $env
);
$base2 = "http://{$host}:{$port2}";
$up2 = false;
for ($i = 0; $i < 50; $i++) {
    $savedBase = $base;
    $base = $base2;
    $probe = req('GET', '/api/health', null, null, 1.0);
    $base = $savedBase;
    if ($probe['status'] === 200) {
        $up2 = true;
        break;
    }
    usleep(100000);
}

if ($up2 && is_resource($server2)) {
    $helperProcess = proc_open(
        [PHP_BINARY, $helper, $base . '/api/signal?since=' . $lastId . '&hold=5', $hostToken],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $helperPipes
    );
    usleep(600000);

    $savedBase = $base;
    $base = $base2; // write goes through the second process
    $pushed = req('POST', '/api/signal', ['name' => 'ice', 'payload' => ['candidate' => 'mid-poll']], $hostToken);
    $base = $savedBase;

    $helperOut = (string) stream_get_contents($helperPipes[1]);
    proc_close($helperProcess);
    proc_terminate($server2);

    $helperJson = json_decode($helperOut, true) ?: [];
    $delivered = json_decode((string) ($helperJson['raw'] ?? ''), true) ?: [];
    $deliveredNames = array_column($delivered['messages'] ?? [], 'name');
    $deliveredIce = in_array('ice', $deliveredNames, true);
    check($pushed['status'] === 201 && $deliveredIce && ($helperJson['elapsed'] ?? 0) >= 0.4,
        'message written by another process reached the held connection',
        $helperOut);
} else {
    echo "  [SKIP] mid-poll delivery -- could not start the second server instance\n";
    if (is_resource($server2)) {
        proc_terminate($server2);
    }
}


section('Rate limiting (per code, architecture doc section 50)');
for ($attempt = 1; $attempt <= 3; $attempt++) {
    $r = req('POST', '/api/sessions/999-997/join', []);
    check($r['status'] === 404, "wrong-code attempt {$attempt} -> 404", $r['raw']);
}
$r = req('POST', '/api/sessions/999-997/join', []);
check($r['status'] === 429, '4th attempt on same code -> 429', $r['raw']);
check((int) ($r['json']['error']['retry_after'] ?? 0) > 0, '429 carries retry_after');

section('Code expiry is lazy (no background daemon needed)');
$exp = req('POST', '/api/sessions', []);
$expCode = (string) ($exp['json']['code'] ?? '');
sleep(3); // code_ttl = 2s in the test config
$joinExpired = req('POST', '/api/sessions/' . $expCode . '/join', []);
check($joinExpired['status'] === 410, 'join after code expiry -> 410', $joinExpired['raw']);

section('Reject flow');
$rej = req('POST', '/api/sessions', []);
$rejSession = (string) ($rej['json']['session_id'] ?? '');
$rejHost = (string) ($rej['json']['host_token'] ?? '');
$rejJoin = req('POST', '/api/sessions/' . ((string) ($rej['json']['code'] ?? '')) . '/join', []);
$rejViewer = (string) ($rejJoin['json']['viewer_token'] ?? '');
$rejResult = req('POST', '/api/sessions/' . $rejSession . '/reject', [], $rejHost);
check($rejResult['status'] === 200 && ($rejResult['json']['state'] ?? '') === 'closed',
    'host rejects viewer -> closed', $rejResult['raw']);
$rejSignal = req('POST', '/api/signal', ['name' => 'ice', 'payload' => []], $rejViewer);
check($rejSignal['status'] === 409, 'rejected viewer cannot signal -> 409', $rejSignal['raw']);

section('Close + post-close behavior');
$close = req('POST', '/api/sessions/' . $sessionId . '/close', [], $viewerToken);
check($close['status'] === 200 && ($close['json']['state'] ?? '') === 'closed',
    'viewer closes session -> closed', $close['raw']);
$afterClose = req('POST', '/api/signal', ['name' => 'ice', 'payload' => []], $hostToken);
check($afterClose['status'] === 409, 'signal after close -> 409', $afterClose['raw']);
$drain = req('GET', '/api/signal?since=0&hold=0', null, $hostToken);
check($drain['status'] === 200, 'host can still drain the queue after close', $drain['raw']);
$drainNames = array_column($drain['json']['messages'] ?? [], 'name');
check(in_array('session.closed', $drainNames, true), 'closed notice is in the queue', json_encode($drainNames));
$closeAgain = req('POST', '/api/sessions/' . $sessionId . '/close', [], $hostToken);
check($closeAgain['status'] === 200, 'second close is an idempotent no-op', $closeAgain['raw']);

section('Payload limits + invalid JSON');
$big = req('POST', '/api/signal', ['name' => 'ice', 'payload' => ['blob' => str_repeat('a', 300000)]], $hostToken);
check($big['status'] === 413, 'oversized signal payload -> 413', (string) $big['status']);
$broken = req('POST', '/api/sessions', '{oops');
check($broken['status'] === 400, 'invalid JSON body -> 400', $broken['raw']);

section('Routing fallback (?r= for hosts without URL rewriting)');
$fallback = req('GET', '/index.php?r=/api/health');
check($fallback['status'] === 200 && ($fallback['json']['ok'] ?? false) === true,
    'query-string routing works', $fallback['raw']);
$notFound = req('GET', '/api/does-not-exist');
check($notFound['status'] === 404, 'unknown endpoint -> 404', $notFound['raw']);

// ------------------------------------------------------------------- summary
echo "\n----------------------------------------\n";
echo 'PASSED: ' . $GLOBALS['pass'] . '   FAILED: ' . $GLOBALS['fail'] . "\n";
exit($GLOBALS['fail'] > 0 ? 1 : 0);


