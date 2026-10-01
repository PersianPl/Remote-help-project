<?php
declare(strict_types=1);

namespace RH\Session;

/**
 * Raised when a join loses a race (another viewer joined first,
 * or the session changed state between check and write).
 */
final class JoinConflictException extends \RuntimeException
{
}
