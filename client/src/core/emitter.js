/**
 * Tiny isomorphic event emitter (no node:events dependency so the same
 * modules run in browsers without a bundler).
 */
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    this._handlers.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    const handlers = this._handlers.get(event);
    if (!handlers) {
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(...args);
      } catch (err) {
        // A broken listener must never take down the connection loop.
        // eslint-disable-next-line no-console
        console.error(`[emitter] handler for "${event}" failed:`, err);
      }
    }
  }

  removeAll() {
    this._handlers.clear();
  }
}
