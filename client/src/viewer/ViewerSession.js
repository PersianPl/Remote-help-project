import { Emitter } from '../core/emitter.js';
import { SessionClient } from '../core/SessionClient.js';
import { LongPollingTransport } from '../core/signaling/LongPollingTransport.js';
import { Peer } from '../core/Peer.js';
import { Negotiator } from '../core/Negotiator.js';
import { FrameReceiver } from '../core/FrameChannel.js';
import { SIGNAL_NAMES } from '../core/protocol.js';
import { Logger } from '../core/logger.js';

export const CHANNEL_LABELS = ['frames', 'input'];

/**
 * Viewer-side session orchestrator.
 *
 * Lifecycle: join(code) → waiting for approval → negotiate (answers the
 * host offer) → connected → render frames + send (locally captured) input.
 * The viewer never creates data channels itself (host owns them) and never
 * performs ICE restarts (host-only, matching the role matrix).
 */
export class ViewerSession extends Emitter {
  constructor({
    baseUrl,
    iceConfig,
    logger = null,
    negotiationTimeoutMs = 20000,
    candidateFilter = null,
    localAddress = null,
    holdSec = 20,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.iceConfig = iceConfig;
    this.logger = logger ?? new Logger({ prefix: 'viewer', level: 'warn' });
    this.negotiationTimeoutMs = negotiationTimeoutMs;
    this.candidateFilter = candidateFilter;
    this.localAddress = localAddress;
    this.holdSec = holdSec;

    this.session = null;
    this.transport = null;
    this.peer = null;
    this.negotiator = null;
    this.receiver = null;
    this.inputChannel = null;

    this.sessionState = 'idle';
    this.peerState = 'new';
    this.signalingUp = false;
    this.ignoredSelfMessages = 0;
    this._cleanedUp = false;
    this._closed = false;
    // Signals can share the batch that carries session.approved: negotiation
    // start is async, so anything arriving in between is buffered and replayed.
    this._pendingSignals = [];
  }

  /** @param {string} code human one-time code, e.g. "583-241" */
  async join(code) {
    this.client = new SessionClient({
      baseUrl: this.baseUrl,
      logger: this.logger,
      localAddress: this.localAddress,
    });
    this.session = await this.client.join(code);

    this.transport = new LongPollingTransport({
      baseUrl: this.baseUrl,
      token: this.session.token,
      logger: this.logger,
      localAddress: this.localAddress,
      holdSec: this.holdSec,
    });
    this.transport.on('message', (m) => { this._onMessage(m); });
    this.transport.on('state', (s) => {
      this.sessionState = s;
      this.emit('state', s);
    });
    this.transport.on('up', () => { this.signalingUp = true; this.emit('signaling', { up: true }); });
    this.transport.on('down', (e) => { this.signalingUp = false; this.emit('signaling', { up: false, ...e }); });
    this.transport.on('ended', (reason) => this._onEnded(reason));
    this.transport.start();
    this.signalingUp = true;

    this.sessionState = 'join_requested';
    this.logger.info('join_requested', { sessionId: this.session.sessionId });
    this.emit('waiting_approval', { sessionId: this.session.sessionId });
    return this.session;
  }

  async _onMessage(message) {
    if (message.sender === 'system') {
      if (message.name === 'session.approved') {
        this.emit('approved');
        // Host may have already sent the offer; messages are ordered, so
        // negotiation must start here and not before (server contract).
        if (!this.negotiator) {
          try {
            await this._startNegotiation();
            await this._drainPendingSignals();
          } catch (err) {
            this._pendingSignals = [];
            this.emit('error', { stage: 'negotiation_start', err: String(err?.message ?? err) });
          }
        }
      } else if (message.name === 'session.rejected') {
        this.emit('rejected');
      }
      return;
    }

    if (!SIGNAL_NAMES.includes(message.name)) {
      return;
    }
    // Shared session queue → our own messages come back too; the server-set
    // sender role identifies them, and replaying them would corrupt roles.
    if (message.sender === this.session.role) {
      this.ignoredSelfMessages += 1;
      return;
    }
    if (message.name === 'status') {
      this.emit('peer_status', message.payload ?? {});
      return;
    }
    if (!this.negotiator) {
      this.logger.debug('signal_buffered', { name: message.name });
      this._pendingSignals.push({ name: message.name, payload: message.payload, sender: message.sender });
      if (this._pendingSignals.length > 32) {
        this._pendingSignals.shift(); // bounded, like every other queue here
      }
      return;
    }
    try {
      await this.negotiator.handleSignal(message.name, message.payload, message.sender);
    } catch (err) {
      this.emit('error', { stage: 'signal', code: err?.code, err: String(err?.message ?? err) });
    }
  }

  /** Replays signals that arrived before negotiation was ready (in order). */
  async _drainPendingSignals() {
    const pending = this._pendingSignals.splice(0);
    for (const signal of pending) {
      try {
        await this.negotiator.handleSignal(signal.name, signal.payload, signal.sender);
      } catch (err) {
        this.emit('error', { stage: 'signal', code: err?.code, err: String(err?.message ?? err) });
      }
    }
  }

  async _startNegotiation() {
    this.peer = await Peer.create(this.iceConfig);
    this.negotiator = new Negotiator({
      role: 'viewer',
      transport: this.transport,
      peer: this.peer,
      channelLabels: CHANNEL_LABELS,
      negotiationTimeoutMs: this.negotiationTimeoutMs,
      candidateFilter: this.candidateFilter,
      logger: this.logger,
    });

    this.negotiator.on('state', (state) => {
      this.peerState = state;
      this.emit('peer_state', state);
    });
    this.negotiator.on('connected', () => {
      this.emit('connected');
      this.transport.send('status', { state: 'connected' })
        .catch((err) => this.logger.warn('status_send_failed', { err: String(err?.message ?? err) }));
    });
    this.negotiator.on('ready', ({ channels }) => {
      this.inputChannel = channels.input;
      this.receiver = new FrameReceiver(channels.frames);
      this.receiver.on('frame', (frame) => this.emit('frame', frame));
      this.receiver.on('invalid', (info) => this.emit('frame_invalid', info));
      this.emit('ready', { channels });
    });
    this.negotiator.on('failed', ({ reason }) => {
      this.emit('failed', { reason });
      this.close({ reason: `negotiation_${reason}` });
    });
    this.negotiator.on('signal_error', (e) => this.emit('signaling_error', e));
    this.negotiator.on('duplicate', (info) => this.emit('duplicate', info));

    this.negotiator.start();
  }

  /**
   * Viewer-side input send. The host remains the authority: everything
   * sent here is re-validated by the host's InputPolicy before injection.
   * @returns {boolean} false when the channel is not open yet
   */
  sendInput(message) {
    const channel = this.inputChannel;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }
    if (channel.bufferedAmount > 256 * 1024) {
      this.emit('input_drop', { reason: 'congested' });
      return false;
    }
    channel.send(JSON.stringify(message));
    return true;
  }

  get connected() {
    return this.peerState === 'connected';
  }

  get frameStats() {
    return this.receiver ? { ...this.receiver.stats } : null;
  }

  _onEnded(reason) {
    this._closed = true; // terminal: no POST /close for an ended session
    this.logger.info('session_ended', { reason });
    this._cleanupLocal();
    this.emit('ended', reason);
    this.emit('closed', { reason });
  }

  async close({ reason = 'local' } = {}) {
    if (this._closed) {
      return;
    }
    this._closed = true;
    try {
      await this.client?.close(this.session.sessionId, this.session.token);
    } catch {
      /* the session may already be closed server-side */
    }
    this._cleanupLocal();
    this.emit('closed', { reason });
  }

  /**
   * Idempotent local teardown. Its own flag matters: close() sets `_closed`
   * first, so gating on `_closed` here would leak every socket.
   */
  _cleanupLocal() {
    if (this._cleanedUp) {
      return;
    }
    this._cleanedUp = true;
    this.receiver?.detach();
    this.receiver = null;
    this.inputChannel = null;
    this.negotiator?.cleanup();
    this.peer?.close();
    this.transport?.stop();
  }

  /** Snapshot for UI / diagnostics (stage 13) — never includes tokens. */
  diagnostics() {
    return {
      role: 'viewer',
      sessionId: this.session?.sessionId ?? null,
      sessionState: this.sessionState,
      signalingUp: this.signalingUp,
      peerState: this.peerState,
      inputChannelOpen: this.inputChannel?.readyState === 'open',
      frameStats: this.frameStats,
    };
  }
}
