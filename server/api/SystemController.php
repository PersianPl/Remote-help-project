<?php
declare(strict_types=1);

namespace RH\Api;

/**
 * Health / hosting-capability endpoints.
 */
final class SystemController
{
    /**
     * GET /api/health (alias: /api/v1/health)
     * GET /api/health?hold=N — holds the connection N seconds (clamped to
     * max_hold) and reports how long it actually survived. Used by
     * tools/host_probe.php to verify long-polling on shared hosting.
     *
     * Never exposes credentials, paths or schema details.
     */
    public static function health(Request $req): void
    {
        $cfg = config();
        $hold = max(0.0, min($req->queryFloat('hold', 0.0), (float) $cfg['max_hold']));
        $start = microtime(true);

        if ($hold > 0) {
            header('X-Accel-Buffering: no');
            while ((microtime(true) - $start) < $hold) {
                if (connection_aborted()) {
                    break;
                }
                usleep(200000);
            }
        }

        // Cheap database probe — result only, no error details leak.
        $dbStatus = 'ok';
        $dbLatencyMs = 0.0;
        $dbStart = microtime(true);
        try {
            database()->pdo()->query('SELECT 1');
        } catch (Throwable) {
            $dbStatus = 'error';
        }
        $dbLatencyMs = round((microtime(true) - $dbStart) * 1000, 2);

        $healthy = $dbStatus === 'ok';
        Response::json([
            'ok' => $healthy,
            'service' => 'remote-help-server',
            'version' => '1',
            'database' => $dbStatus,
            'db_latency_ms' => $dbLatencyMs,
            'time' => time(),
            'php' => PHP_VERSION,
            'held' => round(microtime(true) - $start, 3),
            'max_hold' => (int) $cfg['max_hold'],
        ], $healthy ? 200 : 503);
    }
}
