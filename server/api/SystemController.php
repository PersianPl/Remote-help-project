<?php
declare(strict_types=1);

namespace RH\Api;

/**
 * Health / hosting-capability endpoints.
 */
final class SystemController
{
    /**
     * GET /api/health
     * GET /api/health?hold=N — holds the connection N seconds (clamped to
     * max_hold) and reports how long it actually survived. Used by
     * tools/host_probe.php to verify long-polling on shared hosting.
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

        Response::json([
            'ok' => true,
            'time' => time(),
            'php' => PHP_VERSION,
            'held' => round(microtime(true) - $start, 3),
            'max_hold' => (int) $cfg['max_hold'],
        ]);
    }
}
