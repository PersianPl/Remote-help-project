<?php
declare(strict_types=1);

namespace RH\Api;

/**
 * Normalized HTTP request.
 *
 * Path resolution supports three deployments:
 *   1. Pretty URLs via .htaccess rewrite (Apache / LiteSpeed)
 *   2. Fallback query string: index.php?r=/api/sessions
 *   3. Document root mistakenly pointed at the project root (/public/... prefix)
 */
final class Request
{
    public readonly string $method;
    public readonly string $path;
    public readonly array $query;
    /** @var array<string, mixed> decoded JSON body (empty array when absent) */
    public readonly array $body;
    public readonly bool $invalidJson;
    public readonly string $raw;
    public readonly ?string $bearer;

    public function __construct()
    {
        $this->method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        $path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
        if (isset($_GET['r']) && is_string($_GET['r'])) {
            $path = $_GET['r'];
        }
        if (str_starts_with($path, '/public/')) {
            $path = substr($path, strlen('/public'));
        } elseif ($path === '/public') {
            $path = '/';
        }
        $this->path = rtrim($path, '/') ?: '/';
        $this->query = $_GET;

        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        $this->bearer = preg_match('/^Bearer\s+(\S+)$/i', (string) $header, $m) === 1 ? $m[1] : null;

        $raw = ($this->method === 'GET' || $this->method === 'HEAD')
            ? ''
            : (string) file_get_contents('php://input');
        $this->raw = $raw;

        // readonly: compute first, assign exactly once
        $body = [];
        $invalidJson = false;
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $body = $decoded;
            } else {
                $invalidJson = true;
            }
        }
        $this->body = $body;
        $this->invalidJson = $invalidJson;
    }

    public function ip(): string
    {
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    }

    public function queryInt(string $key, int $default): int
    {
        $value = $this->query[$key] ?? null;
        return is_numeric($value) ? (int) $value : $default;
    }

    public function queryFloat(string $key, float $default): float
    {
        $value = $this->query[$key] ?? null;
        return is_numeric($value) ? (float) $value : $default;
    }
}
