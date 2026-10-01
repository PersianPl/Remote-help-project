import { Emitter } from '../core/emitter.js';
import { SessionClient } from '../core/SessionClient.js';
import { LongPollingTransport } from '../core/signaling/LongPollingTransport.js';
import { Peer } from '../core/Peer.js';
import { Negotiator } from '../core/Negotiator.js';
import { InputPolicy } from '../core/InputPolicy.js';
import { FrameSender } from '../core/FrameChannel.js';
import { SIGNAL_NAMES, DEFAULT_INPUT_BOUNDS } from '../core/protocol.js';
import { Logger } from '../core/logger.js';

export const CHANNEL_LABELS = ['frames', 'input'];

/**
 * Host-side session orchestrator (stages 5/9/11 + 3 wiring).
 *
 * Lifecycle: create → (viewer joins) → approve → negotiate → connected
 * → share frames / accept gated input → close.
 * Frames leave via WebRTC datachannel only; input reaches the injector
 * exclusively through InputPolicy.accept() (explicit approval first).
 */
export class HostSession extends Emitter {
  constructor({
    baseUrl,
    iceConfig,
    logger = null,
    negotiationTimeoutMs = 20000,
    candidateFilter = null,
    autoApprove = false,
    inputBounds = DEFAULT_INPUT_BOUNDS,
    inputRatePerSec = 500,
    localAddress = null,
    holdSec = 20,
  } = {}) {
    super();
    this.baseUrl = baseUrl;
    this.iceConfig = iceConfig;
    this.logger = logger ?? new Logger({ prefix: 'host', level: 'warn' });
    this.negotiationTimeoutMs = negotiationTimeoutMs;
    this.candidateFilter = candidateFilter;
    this.autoApprove = autoApprove;
    this.inputBounds = inputBounds;
    this.inputRatePerSec = inputRatePerSec;
    this.localAddress = localAddress;
    this.holdSec = holdSec;

    this.session = null;
    this.transport = null;
    this.peer = null;
    this.negotiator = null;
    this.inputPolicy = null;
    this.frameSender = null;
    this.sessionState = 'waiting';
    this.peerState = 'new';
    this.signalingUp = false;
    this.ignoredSelfMessages = 0;
    this._approved = false;
    this._closed = false;
    this._cleanedUp = false;
  }

  async create() {
    this.client = new SessionClient({ baseUrl: this.baseUrl, logger: this.logger, localAddress: this.localAddress });
    this.session = await this.client.create();

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

    this.logger.info('session_created', { sessionId: this.session.sessionId, expiresAt: this.session.expiresAt });
    this.emit('created', { code: this.session.code, expiresAt: this.session.codeExpiresAt });
    return this.session;
  }

  async _onMessage(message) {
    if (message.sender === 'system') {
      if (message.name === 'session.join_requested') {
        this.emit('viewer_joined');
        // NOTE: this message is emitted *before* the transport's 'state'
        // event for the same batch, so the local sessionState mirror can
        // still read 'waiting' here. Never gate auto-approval on it —
        // approve() itself is idempotent and the server is the authority.
        if (this.autoApprove) {
          try {
            await this.approve();
          } catch (err) {
            this.emit('error', { stage: 'auto_approve', err: String(err?.message ?? err) });
          }
        }
      }
      return;
    }

    if (!SIGNAL_NAMES.includes(message.name)) {
      return;
    }
    // The session queue is shared: both participants see every message,
    // including their own. The server stamps the authenticated role, so an
    // echo of our own signal is safely identified and must be ignored.
    if (message.sender === this.session.role) {
      this.ignoredSelfMessages += 1;
      return;
    }
    if (message.name === 'status') {
      this.emit('peer_status', message.payload ?? {});
      return;
    }
    if (!this.negotiator) {
      this.logger.warn('signal_before_negotiation', { name: message.name });
      return;
    }
    try {
      await this.negotiator.handleSignal(message.name, message.payload, message.sender);
    } catch (err) {
      this.emit('error', { stage: 'signal', code: err?.code, err: String(err?.message ?? err) });
    }
  }

  async approve() {
    if (this._approved) {
      return; // at-least-once delivery: approving twice must be harmless
    }
    this._approved = true;
    await this.client.approve(this.session.sessionId, this.session.token);
    this.sessionState = 'approved';
    this.emit('approved');
    await this._startNegotiation();
  }

  async reject() {
    await this.client.reject(this.session.sessionId, this.session.token);
    this.emit('rejected');
  }

  async _startNegotiation() {
    this.peer = await Peer.create(this.iceConfig);
    this.negotiator = new Negotiator({
      role: 'host',
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
      this.frameSender = new FrameSender(channels.frames);
      this.inputPolicy = new InputPolicy({
        bounds: this.inputBounds,
        maxRatePerSec: this.inputRatePerSec,
      });
      this._wireInput(channels.input);
      this.emit('ready', { channels });
    });
    this.negotiator.on('failed', ({ reason }) => {
      this.emit('failed', { reason });
      this.close({ reason: `negotiation_${reason}` });
    });
    this.negotiator.on('signal_error', (e) => this.emit('signaling_error', e));
    this.negotiator.on('ice_restart', (info) => this.emit('ice_restart', info));

    this.negotiator.start();
  }

  /** Remote input is consumed ONLY after InputPolicy accepted it. */
  _wireInput(channel) {
    channel.onmessage = (event) => {
      const raw = event?.data ?? event;
      if (typeof raw !== 'string') {
        return; // the input channel is JSON-only
      }
      const result = this.inputPolicy.accept(raw);
      if (!result.ok) {
        this.emit('input_rejected', { reason: result.reason });
        return;
      }
      this.emit('input', result.msg);
    };
  }

  /** Stage 11: the host toggles remote input explicitly, per session. */
  allowRemoteInput() {
    this.inputPolicy?.enable();
    this.emit('input_state', { enabled: true });
  }

  disallowRemoteInput() {
    this.inputPolicy?.disable();
    this.emit('input_state', { enabled: false });
  }

  get inputEnabled() {
    return this.inputPolicy?.enabled === true;
  }

  /** @returns {boolean} false when not connected or congested */
  sendFrame(frame) {
    if (!this.frameSender) {
      return false;
    }
    return this.frameSender.send(frame);
  }

  _onEnded(reason) {
    this._closed = true; // terminal: never POST /close for an ended session
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
    this.inputPolicy?.disable();
    try {
      await this.client?.close(this.session.sessionId, this.session.token);
    } catch {
      /* the session may already be closed server-side */
    }
    this._cleanupLocal();
    this.emit('closed', { reason });
  }

  /**
   * Idempotent local teardown. Uses its own flag: close() sets `_closed`
   * first, so gating this on `_closed` would skip every socket/channel
   * release and leak the peer connection.
   */
  _cleanupLocal() {
    if (this._cleanedUp) {
      return;
    }
    this._cleanedUp = true;
    this.inputPolicy?.disable();
    this.frameSender = null;
    this.negotiator?.cleanup();
    this.peer?.close();
    this.transport?.stop();
  }

  /** Snapshot for UI / diagnostics (stage 13) — never includes tokens. */
  diagnostics() {
    return {
      role: 'host',
      sessionId: this.session?.sessionId ?? null,
      sessionState: this.sessionState,
      signalingUp: this.signalingUp,
      peerState: this.peerState,
      inputEnabled: this.inputEnabled,
      inputEnabledAvailable: this.inputPolicy !== null,
      inputPolicyStats: this.inputPolicy ? { ...this.inputPolicy.stats } : null,
      frameStats: this.frameSender ? { ...this.frameSender.stats } : null,
    };
  }
}
