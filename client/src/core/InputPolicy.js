import { parseInputMessage, ProtocolError, DEFAULT_INPUT_BOUNDS } from './protocol.js';

/**
 * Host-side gate for remote input (stages 9/10/11).
 *
 * Three independent controls, all required before any injection:
 *   1. explicit host approval  (enable() — never defaults to true)
 *   2. strict schema validation (parseInputMessage)
 *   3. rate limiting           (token bucket)
 *
 * This module performs NO OS injection itself — the injector is a separate
 * component that only ever receives messages this class accepted.
 */
export class InputPolicy {
  constructor({
    bounds = DEFAULT_INPUT_BOUNDS,
    maxRatePerSec = 500,
    burst = 250,
  } = {}) {
    this.bounds = bounds;
    this.maxRatePerSec = maxRatePerSec;
    this.burst = burst;
    this.enabled = false; // stage 11: opt-in only, per session
    this._tokens = burst;
    this._lastRefill = Date.now();
    this.stats = { accepted: 0, rejected: 0, rateLimited: 0 };
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  /** Update coordinate bounds when the host resolution changes. */
  setBounds(bounds) {
    this.bounds = bounds;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed <= 0) {
      return;
    }
    this._tokens = Math.min(this.burst, this._tokens + elapsed * this.maxRatePerSec);
    this._lastRefill = now;
  }

  /**
   * @param {string} rawText raw JSON string from the input datachannel
   * @returns {{ok: true, msg: object} | {ok: false, reason: string}}
   */
  accept(rawText) {
    if (!this.enabled) {
      this.stats.rejected += 1;
      return { ok: false, reason: 'input_disabled' };
    }

    let msg;
    try {
      msg = parseInputMessage(rawText, this.bounds);
    } catch (err) {
      this.stats.rejected += 1;
      return { ok: false, reason: err instanceof ProtocolError ? err.code : 'input_invalid' };
    }

    this._refill();
    if (this._tokens < 1) {
      this.stats.rateLimited += 1;
      this.stats.rejected += 1;
      return { ok: false, reason: 'rate_limited' };
    }
    this._tokens -= 1;
    this.stats.accepted += 1;
    return { ok: true, msg };
  }
}
