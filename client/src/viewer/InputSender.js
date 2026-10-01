import { BLOCKED_KEYS, MOUSE_BUTTONS, MOUSE_ACTIONS, KEY_ACTIONS } from '../core/protocol.js';

/**
 * Viewer-side input producer.
 *
 * The viewer is not an authority — the host re-validates everything through
 * InputPolicy — but we still refuse to *build* obviously unsafe messages
 * (Win/meta combinations and control characters) so they never reach the
 * wire at all. A simple token bucket keeps the datachannel sane.
 */
export class InputSender {
  constructor(session, { maxRatePerSec = 120, burst = 60, logger = null } = {}) {
    this.session = session;
    this.maxRatePerSec = maxRatePerSec;
    this.burst = burst;
    this.logger = logger;
    this._tokens = burst;
    this._lastRefill = Date.now();
    this.stats = { sent: 0, dropped: 0, refused: 0 };
  }

  _allow() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed > 0) {
      this._tokens = Math.min(this.burst, this._tokens + elapsed * this.maxRatePerSec);
      this._lastRefill = now;
    }
    if (this._tokens < 1) {
      return false;
    }
    this._tokens -= 1;
    return true;
  }

  _send(message) {
    if (!this._allow()) {
      this.stats.dropped += 1;
      return false;
    }
    const ok = this.session.sendInput(message);
    if (ok) {
      this.stats.sent += 1;
    } else {
      this.stats.dropped += 1;
    }
    return ok;
  }

  /** @param {string} action move|down|up|wheel|dblclick */
  mouse(action, { x = 0, y = 0, button = 'left', delta = 0 } = {}) {
    if (!MOUSE_ACTIONS.includes(action)) {
      this.stats.refused += 1;
      return false;
    }
    const message = { t: 'input', kind: 'mouse', action, x: Math.round(x), y: Math.round(y) };
    if (action === 'down' || action === 'up' || action === 'dblclick') {
      if (!MOUSE_BUTTONS.includes(button)) {
        this.stats.refused += 1;
        return false;
      }
      message.button = button;
    }
    if (action === 'wheel') {
      const clamped = Math.max(-1000, Math.min(1000, Math.trunc(delta)));
      if (clamped === 0) {
        this.stats.refused += 1;
        return false;
      }
      message.delta = clamped;
    }
    return this._send(message);
  }

  move(x, y) { return this.mouse('move', { x, y }); }
  down(button = 'left') { return this.mouse('down', { button }); }
  up(button = 'left') { return this.mouse('up', { button }); }
  click(button = 'left') { return this.down(button) && this.up(button); }
  wheel(delta, x = 0, y = 0) { return this.mouse('wheel', { delta, x, y }); }

  /** @param {string} action down|up */
  key(action, key, modifiers = {}) {
    if (!KEY_ACTIONS.includes(action) || typeof key !== 'string' || key.length === 0) {
      this.stats.refused += 1;
      return false;
    }
    // Refuse locally too: meta and the permanent blocklist never go on the wire.
    if (modifiers?.meta === true || BLOCKED_KEYS.includes(key.toLowerCase())) {
      this.stats.refused += 1;
      this.logger?.warn('key_refused_locally', { key });
      return false;
    }
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7E]+$/.test(key)) {
      this.stats.refused += 1;
      return false;
    }
    const message = {
      t: 'input',
      kind: 'key',
      action,
      key,
      modifiers: {
        ctrl: modifiers?.ctrl === true,
        alt: modifiers?.alt === true,
        shift: modifiers?.shift === true,
        meta: false,
      },
    };
    return this._send(message);
  }

  keyDown(key, modifiers) { return this.key('down', key, modifiers); }
  keyUp(key, modifiers) { return this.key('up', key, modifiers); }

  /** A full keystroke: down + up with modifiers held (for shortcuts). */
  keystroke(key, modifiers = {}) {
    const down = this.key('down', key, modifiers);
    const up = this.key('up', key, modifiers);
    return down && up;
  }
}
