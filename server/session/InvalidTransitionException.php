<?php
declare(strict_types=1);

namespace RH\Session;

/**
 * Raised when code attempts a transition outside SessionState::ALLOWED.
 * Internal misuse — endpoints translate it into a 409 response.
 */
final class InvalidTransitionException extends \RuntimeException
{
}
