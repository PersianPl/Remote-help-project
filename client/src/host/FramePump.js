import { Emitter } from '../core/emitter.js';

/**
 * Screen-sharing pump (stage 8 wiring): capture → JPEG → frames datachannel.
 *
 * Policy:
 * - fixed target FPS with drift compensation (never "catch up" by bursting)
 * - congestion is handled by DROPPING, not queueing (FrameSender already
 *   refuses to enqueue when the channel is backed up)
 * - a slow frame never blocks the next tick indefinitely: capture is
 *   awaited, but afterwards the loop sleeps only what is left of the budget
 * - pause() holds the loop without tearing down the session
 */
export class FramePump extends Emitter {
  constructor(session, capture, { fps = 8, logger = null } = {}) {
    super();
    this.session = session;
    this.capture = capture;
    this.fps = fps;
    this.logger = logger;

    this.running = false;
    this.paused = false;
    this.stats = {
      pumped: 0, dropped: 0, errors: 0, bytes: 0,
      lastCaptureMs: 0, lastEncodeMs: 0, lastFps: 0, _marks: [],
    };
    this._stopped = null;
  }

  setFps(fps) {
    this.fps = Math.max(1, Math.min(30, Math.round(fps)));
    return this.fps;
  }

  get intervalMs() {
    return 1000 / this.fps;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.paused = false;
    this.startedAt = Date.now();
    this._loop().catch((err) => {
      this.logger?.error('frame_pump_crashed', { err: String(err?.message ?? err) });
      this.running = false;
      this.emit('failed', err);
    });
  }

  pause() {
    this.paused = true;
    this.emit('paused', true);
  }

  resume() {
    this.paused = false;
    this.emit('paused', false);
  }

  stop() {
    this.running = false;
    this._stopped?.();
    this._stopped = null;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this._stopped = null;
        resolve();
      }, ms);
      this._stopped = () => {
        clearTimeout(timer);
        this._stopped = null;
        resolve();
      };
    });
  }

  async _loop() {
    while (this.running) {
      if (this.paused) {
        await this._sleep(100);
        continue;
      }
      const started = Date.now();
      try {
        const frame = await this.capture.grab();
        this.stats.lastCaptureMs = frame.captureMs ?? 0;
        this.stats.lastEncodeMs = frame.encodeMs ?? 0;
        const sent = this.session.sendFrame(frame);
        if (sent) {
          this.stats.pumped += 1;
          this.stats.bytes += frame.data.byteLength;
          this.emit('frame', frame);
        } else {
          this.stats.dropped += 1;
          this.emit('drop', { reason: 'congested' });
        }
      } catch (err) {
        this.stats.errors += 1;
        this.emit('error', err);
        this.logger?.warn('frame_grab_failed', { err: String(err?.message ?? err) });
      }

      const elapsed = Date.now() - started;
      this._markAndMeasure();
      await this._sleep(Math.max(0, this.intervalMs - elapsed));
    }
    this.emit('stopped');
  }

  /** Measured FPS over a 2s sliding window (what the peer actually gets). */
  _markAndMeasure() {
    const marks = this.stats._marks;
    const now = Date.now();
    marks.push(now);
    const cutoff = now - 2000;
    while (marks.length && marks[0] < cutoff) {
      marks.shift();
    }
    this.stats.lastFps = Math.round((marks.length * 1000) / 2000 * 10) / 10;
  }

  /** Snapshot for the host UI/diagnostics. */
  diagnostics() {
    const { _marks, ...visible } = this.stats;
    const seconds = Math.max(0.001, (Date.now() - (this.startedAt ?? Date.now())) / 1000);
    return {
      ...visible,
      targetFps: this.fps,
      running: this.running,
      paused: this.paused,
      avgKbps: Math.round((this.stats.bytes * 8) / 1000 / seconds),
    };
  }
}
