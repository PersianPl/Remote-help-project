<?php
declare(strict_types=1);

/**
 * Remote Help backend bootstrap.
 *
 * Autoloads the RH\* classes (mapped to this directory) and exposes
 * tiny helpers for config/database access.
 *
 * Namespace map: RH\Api\Request -> server/api/Request.php, etc.
 */

spl_autoload_register(static function (string $class): void {
    $prefix = 'RH\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

/**
 * Loads configuration once.
 *
 * Resolution order:
 *   1. RH_CONFIG environment variable (absolute path to a PHP file)
 *   2. config/config.php (production, git-ignored)
 *   3. config/config.example.php (fallback so the app boots out of the box)
 */
function config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $file = getenv('RH_CONFIG');
    if ($file === false || $file === '' || !is_file($file)) {
        $file = __DIR__ . '/config/config.php';
    }
    if (!is_file($file)) {
        $file = __DIR__ . '/config/config.example.php';
    }
    $loaded = require $file;
    if (!is_array($loaded)) {
        throw new RuntimeException('Configuration file must return an array: ' . $file);
    }
    $config = $loaded;
    return $config;
}

/**
 * Shared database handle; migrates the schema on first use.
 */
function database(): RH\Storage\Database
{
    static $db = null;
    if ($db === null) {
        $db = new RH\Storage\Database(config()['db'] ?? []);
        $db->migrate();
    }
    return $db;
}

/**
 * Current Unix time (single helper so tests can reason about time usage).
 */
function now(): int
{
    return time();
}

/**
 * Shared signaling queue handle.
 */
function signals(): RH\Signaling\SignalStore
{
    static $signals = null;
    if ($signals === null) {
        $signals = new RH\Signaling\SignalStore(database());
    }
    return $signals;
}

/**
 * Shared session store (state machine + code lifecycle).
 */
function store(): RH\Session\SessionStore
{
    static $store = null;
    if ($store === null) {
        $store = new RH\Session\SessionStore(database(), config(), signals());
    }
    return $store;
}

