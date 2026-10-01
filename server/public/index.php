<?php
declare(strict_types=1);

/**
 * Remote Help — front controller.
 *
 * Deploy:     point the web server document root at this public/ directory.
 * Local dev:  php -S 127.0.0.1:8080 -t public public/router.php
 */

require dirname(__DIR__) . '/bootstrap.php';

use RH\Api\Request;
use RH\Api\Response;
use RH\Api\Router;

// Long-poll friendly output: never buffer the held response.
if (function_exists('ob_implicit_flush')) {
    ob_implicit_flush(true);
}
header_remove('X-Powered-By');

// Security headers (prompt stage 16). API returns JSON only —
// nosniff + frame denial + no referrer cover the relevant surface.
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

try {
    $request = new Request();

    // CORS is opt-in (native desktop clients do not need it).
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '' && in_array($origin, config()['allowed_origins'] ?? [], true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Headers: Authorization, Content-Type');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        if ($request->method === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    (new Router())->dispatch($request);
} catch (Throwable $e) {
    // Log class + message only — never tokens, codes or payloads.
    Logger::error('uncaught', ['class' => get_class($e), 'message' => $e->getMessage()]);
    Response::error('internal_error', 'Internal server error', 500);
}
