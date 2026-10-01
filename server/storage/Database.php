<?php
declare(strict_types=1);

namespace RH\Storage;

use PDO;
use RuntimeException;

/**
 * Thin PDO wrapper supporting sqlite (development / simple hosting)
 * and mysql (production). Schema is applied from storage/schema.*.sql.
 */
final class Database
{
    private ?PDO $pdo = null;

    public function __construct(private readonly array $config)
    {
    }

    public function driver(): string
    {
        return $this->config['driver'] ?? 'sqlite';
    }

    public function pdo(): PDO
    {
        if ($this->pdo === null) {
            $this->pdo = $this->connect();
            $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        }
        return $this->pdo;
    }

    private function connect(): PDO
    {
        if ($this->driver() === 'mysql') {
            $m = $this->config['mysql'] ?? [];
            foreach (['host', 'name', 'user'] as $key) {
                if (!isset($m[$key]) || $m[$key] === '') {
                    throw new RuntimeException('Missing db.mysql.' . $key . ' in configuration');
                }
            }
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=%s',
                (string) $m['host'],
                (int) ($m['port'] ?? 3306),
                (string) $m['name'],
                (string) ($m['charset'] ?? 'utf8mb4')
            );
            return new PDO($dsn, (string) $m['user'], (string) ($m['pass'] ?? ''));
        }

        $path = (string) ($this->config['sqlite_path'] ?? ':memory:');
        if ($path !== ':memory:') {
            $dir = dirname($path);
            if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException('Cannot create sqlite directory: ' . $dir);
            }
        }
        $pdo = new PDO('sqlite:' . $path);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        return $pdo;
    }

    /**
     * Executes the dialect-specific schema file (idempotent: CREATE IF NOT EXISTS).
     */
    public function migrate(): void
    {
        $file = __DIR__ . '/schema.' . $this->driver() . '.sql';
        $sql = file_get_contents($file);
        if ($sql === false) {
            throw new RuntimeException('Cannot read schema file: ' . $file);
        }
        foreach (explode(';', $sql) as $statement) {
            $statement = trim($statement);
            if ($statement !== '') {
                $this->pdo()->exec($statement);
            }
        }
    }
}
