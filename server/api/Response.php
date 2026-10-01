<?php
declare(strict_types=1);

namespace RH\Api;

/**
 * JSON responses. Every helper terminates the request.
 */
final class Response
{
    public static function json(mixed $data, int $status = 200, array $headers = []): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        foreach ($headers as $name => $value) {
            header($name . ': ' . $value);
        }
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function error(string $code, string $message, int $status, array $extra = []): never
    {
        self::json(['error' => array_merge(['code' => $code, 'message' => $message], $extra)], $status);
    }
}
