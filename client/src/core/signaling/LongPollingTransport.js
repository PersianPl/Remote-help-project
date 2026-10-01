import { SignalingTransport } from './SignalingTransport.js';
import { httpJson, NetworkError } from '../http.js';
import { PROTOCOL_VERSION, isFinalState } from '../protocol.js';

/**
 * Active signaling transport: Long Polling over the v1 REST API.
 *
 * - GET  /api/v1/signal?since=N&hold=S  (server holds the connection)
 * - POST /api/v1/signal {v, name, payload}
 *
 * Behavior (stage 7 requirements):
 * - monotonic `since` cursor → no duplicate delivery to the app
 * - network failure → bounded exponential backoff (500ms → 15s)
 * - final session states terminate the loop (no infinite polling)
 * - stop() aborts the in-flight hold promptly
 * - HTTP 401/409/410 terminate with a precise 'ended' reason
 */
export class LongPollingTransport extends SignalingTransport {
  constructor({
    baseUrl,
    token,
    since = 0,
    holdSec = 20,
    pollPauseMs = 50,
    backoffBaseMs = 500,
    backoffMaxMs = 15000,
    localAddress = null,
    logger = null,
  } = {}) {
    super();
    if (!baseUrl || !token) {
      throw new Error('LongPollingTransport requires baseUrl and token');
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.since = Math.max(0, since);
    this.holdSec = holdSec;
    this.pollPauseMs = pollPauseMs;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.localAddress = localAddress;
    this.logger = logger;

    this.running = false;
    this._abort = null;
    this._wake = null;
    this._ended = false;
    this._backoffMs = backoffBaseMs;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this._loop().catch((err) => {
      this.logger?.error('poll_loop_crashed', { err: String(err?.message ?? err) });
      this._end('loop_crashed');
    });
  }

  stop() {
    this.running = false;
    this._abort?.abort(new Error('stopped'));
    this._wake?.();
  }

  _end(reason) {
    if (this._ended) {
      return;
    }
    this._ended = true;
    this.running = false;
    this.emit('ended', reason);
    this._wake?.();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null;
        resolve();
      }, ms);
      this._wake = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve();
      };
    });
  }

  async _loop() {
    while (this.running) {
      const controller = new AbortController();
      this._abort = controller;
      try {
        const url = `${this.baseUrl}/api/v1/signal?since=${this.since}&hold=${this.holdSec}`;
        const res = await httpJson({
          url,
          headers: { Authorization: `Bearer ${this.token}` },
          timeoutMs: (this.holdSec + 15) * 1000,
          localAddress: this.localAddress,
          signal: controller.signal,
        });
        if (!this.running) {
          return;
        }

        if (res.status === 401 || res.status === 403) {
          this._end('auth');
          return;
        }
        if (res.status === 409 || res.status === 410) {
          this._end(res.data?.error?.code ?? 'session_ended');
          return;
        }
        if (res.status !== 200) {
          throw new NetworkError(`poll HTTP ${res.status}`, `http_${res.status}`);
        }

        const data = res.data ?? {};
        const messages = Array.isArray(data.messages) ? data.messages : [];
        let endedByMessage = null;

        for (const message of messages) {
          const id = Number(message.id);
          if (Number.isFinite(id)) {
            this.since = Math.max(this.since, id);
          }
          this.emit('message', message);
          if (message.sender === 'system'
            && (message.name === 'session.closed' || message.name === 'session.expired')) {
            endedByMessage = message.name;
          }
        }
        if (typeof data.state === 'string') {
          this.emit('state', data.state);
          if (isFinalState(data.state)) {
            endedByMessage = endedByMessage ?? `state_${data.state}`;
          }
        }

        this._backoffMs = this.backoffBaseMs;
        this.logger?.debug('poll', { count: messages.length, since: this.since, state: data.state });

        if (endedByMessage) {
          this._end(endedByMessage);
          return;
        }
        if (messages.length === 0) {
          await this._sleep(this.pollPauseMs);
        }
      } catch (err) {
        if (!this.running) {
          return;
        }
        const stopped = controller.signal.aborted
          && String(controller.signal.reason?.message ?? '') === 'stopped';
        if (stopped) {
          return;
        }
        this.emit('down', { reason: err?.code ?? 'network', detail: String(err?.message ?? err) });
        this.logger?.warn('poll_down', { err: String(err?.message ?? err), backoffMs: this._backoffMs });
        await this._sleep(this._backoffMs);
        this._backoffMs = Math.min(this._backoffMs * 2, this.backoffMaxMs);
        if (this.running) {
          this.emit('up', { reason: 'retry' });
        }
      } finally {
        this._abort = null;
      }
    }
  }

  /** @returns {Promise<number>} id of the stored message */
  async send(name, payload) {
    const res = await httpJson({
      method: 'POST',
      url: `${this.baseUrl}/api/v1/signal`,
      headers: { Authorization: `Bearer ${this.token}` },
      body: { v: PROTOCOL_VERSION, name, payload },
      timeoutMs: 15000,
      localAddress: this.localAddress,
    });
    if (res.status >= 400) {
      const err = res.data?.error ?? {};
      const apiError = Object.assign(new Error(err.message ?? `signal HTTP ${res.status}`), {
        name: 'ApiError',
        status: res.status,
        code: err.code ?? 'http_error',
      });
      if (res.status === 409 || res.status === 410) {
        this._end(err.code ?? 'session_ended');
      }
      throw apiError;
    }
    return Number(res.data?.id ?? 0);
  }
}

