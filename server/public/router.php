<?php
declare(strict_types=1);

// Dev router for `php -S` (production uses .htaccess with the same effect).
// Usage: php -S 127.0.0.1:8080 -t public public/router.php
$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';

if ($path !== '/' && is_file(__DIR__ . $path)) {
    return false; // let the built-in server serve the real file
}

require __DIR__ . '/index.php';
