import { Emitter } from '../emitter.js';

/**
 * SignalingTransport contract (stages 3 + 10).
 *
 * The application layer only knows this interface — the concrete wire
 * format (Long Polling today; WebSocket/SSE later) stays behind it:
 *
 *   const t = new LongPollingTransport({...});
 *   t.on('message', ({id, sender, name, payload, ts}) => {...});
 *   t.on('state',   (sessionState) => {...});
 *   t.on('up' | 'down', ({reason}) => {...});   // connectivity
 *   t.on('ended',  (reason) => {...});          // session closed/expired/auth
 *   t.start();
 *   await t.send('offer', {sdp});               // role/state enforced server-side
 *   t.stop();
 *
 * Guarantees every implementation must provide:
 * - ordered delivery per session (monotonic cursor, at-least-once with
 *   client-side cursor dedup)
 * - bounded memory (cursor only, no unbounded buffering)
 * - stop() terminates promptly, including any in-flight hold
 */
export class SignalingTransport extends Emitter {
  start() {
    throw new Error('SignalingTransport.start() not implemented');
  }

  stop() {
    throw new Error('SignalingTransport.stop() not implemented');
  }

  async send(_name, _payload) {
    throw new Error('SignalingTransport.send() not implemented');
  }
}
