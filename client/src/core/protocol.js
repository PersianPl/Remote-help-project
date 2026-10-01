/**
 * Protocol v1 — single client-side source of truth.
 * Mirrors shared/protocol/v1.md + server implementation. Pure module:
 * no Node/browser APIs, safe to import from both.
 */

export const PROTOCOL_VERSION = 1;

export const SIGNAL_NAMES = Object.freeze(['offer', 'answer', 'ice', 'status']);

/** Role permissions — identical to server ROLE_MATRIX (stage 6). */
export const ROLE_MATRIX = Object.freeze({
  offer: Object.freeze(['host']),
  answer: Object.freeze(['viewer']),
  ice: Object.freeze(['host', 'viewer']),
  status: Object.freeze(['host', 'viewer']),
});

export const SESSION_STATES = Object.freeze([
  'waiting', 'join_requested', 'approved', 'negotiating',
  'connected', 'closed', 'expired',
]);

/** Legal transitions — identical to server SessionState::ALLOWED (stage 5). */
export const ALLOWED_TRANSITIONS = Object.freeze({
  waiting: Object.freeze(['join_requested', 'closed', 'expired']),
  join_requested: Object.freeze(['approved', 'closed', 'expired']),
  approved: Object.freeze(['negotiating', 'closed', 'expired']),
  negotiating: Object.freeze(['connected', 'closed', 'expired']),
  connected: Object.freeze(['closed', 'expired']),
  closed: Object.freeze([]),
  expired: Object.freeze([]),
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function isFinalState(state) {
  return state === 'closed' || state === 'expired';
}

export function maySignal(role, name) {
  return (ROLE_MATRIX[name] ?? []).includes(role);
}

export class ProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input messages (datachannel "input" channel, JSON, strictly bounded).
// Stage 9/10: validation lives here; injection is a separate, gated step.
// ---------------------------------------------------------------------------

export const MAX_INPUT_JSON_CHARS = 1024;
export const INPUT_KINDS = Object.freeze(['mouse', 'key']);
export const MOUSE_ACTIONS = Object.freeze(['move', 'down', 'up', 'wheel', 'dblclick']);
export const KEY_ACTIONS = Object.freeze(['down', 'up']);
export const MOUSE_BUTTONS = Object.freeze(['left', 'right', 'middle']);
export const MOUSE_BUTTON_CODES = Object.freeze({ left: 0, middle: 1, right: 2 });

/** Keys/combinations the app refuses to inject, ever (stage 10 safety). */
export const BLOCKED_KEYS = Object.freeze([
  'lwin', 'rwin', 'win', 'meta', 'leftwin', 'rightwin',
  'altf4', 'ctrlaltdel', 'ctrl+alt+del', 'pause',
]);

export const DEFAULT_INPUT_BOUNDS = Object.freeze({ width: 7680, height: 4320 });

/**
 * Validates + normalizes a raw input message.
 * @throws {ProtocolError} with a machine-readable code
 */
export function parseInputMessage(text, bounds = DEFAULT_INPUT_BOUNDS) {
  if (typeof text !== 'string') {
    throw new ProtocolError('input message must be a string', 'input_type');
  }
  if (text.length > MAX_INPUT_JSON_CHARS) {
    throw new ProtocolError('input message too large', 'input_size');
  }

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new ProtocolError('input message is not valid JSON', 'input_json');
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.t !== 'input') {
    throw new ProtocolError('input message shape is invalid', 'input_shape');
  }
  if (!INPUT_KINDS.includes(msg.kind)) {
    throw new ProtocolError('unknown input kind', 'input_kind');
  }

  return msg.kind === 'mouse' ? parseMouse(msg, bounds) : parseKey(msg);
}

function finiteCoord(value, max, field) {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new ProtocolError(`${field} out of bounds`, 'input_bounds');
  }
  return Math.round(value);
}

function parseMouse(msg, bounds) {
  if (!MOUSE_ACTIONS.includes(msg.action)) {
    throw new ProtocolError('unknown mouse action', 'input_action');
  }

  const out = {
    kind: 'mouse',
    action: msg.action,
    x: finiteCoord(msg.x, bounds.width, 'x'),
    y: finiteCoord(msg.y, bounds.height, 'y'),
  };

  if (msg.action === 'down' || msg.action === 'up' || msg.action === 'dblclick') {
    const button = msg.button === undefined ? 'left' : msg.button;
    if (!MOUSE_BUTTONS.includes(button)) {
      throw new ProtocolError('unknown mouse button', 'input_button');
    }
    out.button = button;
  }

  if (msg.action === 'wheel') {
    if (!Number.isFinite(msg.delta) || Math.abs(msg.delta) > 1000) {
      throw new ProtocolError('wheel delta out of range', 'input_wheel');
    }
    out.delta = Math.trunc(msg.delta);
  }

  return out;
}

function parseKey(msg) {
  if (!KEY_ACTIONS.includes(msg.action)) {
    throw new ProtocolError('unknown key action', 'input_action');
  }
  const key = msg.key;
  if (typeof key !== 'string' || key.length < 1 || key.length > 32) {
    throw new ProtocolError('key name invalid', 'input_key');
  }
  // Printable ASCII only — no control characters ever enter the injector.
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7E]+$/.test(key)) {
    throw new ProtocolError('key name contains control characters', 'input_key');
  }
  if (BLOCKED_KEYS.includes(key.toLowerCase())) {
    throw new ProtocolError('key is on the permanent blocklist', 'input_blocked_key');
  }

  const mods = msg.modifiers ?? {};
  for (const name of ['ctrl', 'alt', 'shift', 'meta']) {
    if (mods[name] !== undefined && typeof mods[name] !== 'boolean') {
      throw new ProtocolError('modifier must be boolean', 'input_modifiers');
    }
  }
  if (mods.meta === true) {
    throw new ProtocolError('meta/Win modifier is never injected', 'input_blocked_modifier');
  }

  return {
    kind: 'key',
    action: msg.action,
    key,
    modifiers: {
      ctrl: mods.ctrl === true,
      alt: mods.alt === true,
      shift: mods.shift === true,
      meta: false,
    },
  };
}
