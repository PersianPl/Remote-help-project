<?php
declare(strict_types=1);

namespace RH\Api;

use RH\Signaling\SignalController;

/**
 * Minimal router. Endpoint map lives here so the protocol surface
 * is visible in one place (see shared/protocol/v1.md).
 */
final class Router
{
    public function dispatch(Request $req): void
    {
        $path = $req->path;
        $method = $req->method;

        // Canonical API lives under /api/v1/... ; the unversioned
        // /api/... form stays as a backward-compatible alias.
        if (preg_match('#^/api/v1(/.*)$#', $path, $v1) === 1) {
            $path = '/api' . $v1[1];
        }

        if ($method === 'GET' && $path === '/api/health') {
            SystemController::health($req);
            return;
        }

        if ($method === 'GET' && $path === '/api/signal') {
            SignalController::poll($req);
            return;
        }
        if ($method === 'POST' && $path === '/api/signal') {
            SignalController::send($req);
            return;
        }

        if ($method === 'POST' && $path === '/api/sessions') {
            SessionController::create($req);
            return;
        }

        if (preg_match('#^/api/sessions/([A-Za-z0-9-]+)$#', $path, $m) === 1 && $method === 'GET') {
            SessionController::show($req, $m[1]);
            return;
        }

        if (preg_match('#^/api/sessions/([A-Za-z0-9-]+)/(join|approve|reject|close)$#', $path, $m) === 1
            && $method === 'POST'
        ) {
            SessionController::transition($req, $m[1], $m[2]);
            return;
        }

        Response::error('not_found', 'No such endpoint', 404);
    }
}
