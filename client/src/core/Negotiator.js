import { Emitter } from './emitter.js';
import { maySignal, ProtocolError } from './protocol.js';

/**
 * Role-aware WebRTC negotiation over the signaling transport (stage 3).
 *
 * - host:   creates data channels, sends `offer`, receives `answer`
 * - viewer: waits for `offer`, replies with `answer`
 * - both:   trickle `ice` (server role matrix enforces directions too)
 * - races:  duplicate offer/answer are ignored, not fatal; remote ICE
 *           that arrives early is buffered by Peer
 * - timeout: hard negotiation deadline; host gets exactly one ICE
 *   restart attempt on 'failed' when the stack supports it
 * - interface policy: optional candidateFilter drops candidates the
 *   user's selected network interface does not own (stage 12)
 */
export class Negotiator extends Emitter {
  constructor({
    role,
    transport,
    peer,
    channelLabels = [],
    negotiationTimeoutMs = 20000,
    candidateFilter = null,
    logger = null,
  }) {
    super();
    if (role !== 'host' && role !== 'viewer') {
      throw new Error('Negotiator role must be host or viewer');
    }
    this.role = role;
    this.transport = transport;
    this.peer = peer;
    this.channelLabels = [...channelLabels];
    this.negotiationTimeoutMs = negotiationTimeoutMs;
    this.candidateFilter = candidateFilter;
    this.logger = logger;

    this.channels = {};
    this._opened = new Set();
    this._started = false;
    this._settled = false;
    this._restarted = false;
    this._answered = false;
    this._receivedAnswer = false;
    this._timer = null;
  }

  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._wirePeer();
    this._armTimer();
    if (this.role === 'host') {
      this._hostBegin().catch((err) => this._fail(`offer_failed:${err?.message ?? err}`));
    }
  }

  _wirePeer() {
    this.peer.on('ice', async (init) => {
      const filtered = this.candidateFilter ? this.candidateFilter(init) : init;
      if (!filtered) {
        this.logger?.debug('ice_filtered', { note: 'dropped by interface policy' });
        return;
      }
      try {
        await this.transport.send('ice', filtered);
      } catch (err) {
        this.emit('signal_error', { name: 'ice', err: String(err?.message ?? err) });
      }
    });
    this.peer.on('state', (state) => {
      this.emit('state', state);
      if (state === 'connected') {
        this._onConnected();
      } else if (state === 'failed') {
        this._onFailed();
      }
    });
    this.peer.on('channel', (channel) => this._adopt(channel));
    this.peer.on('ice_error', (err) => this.emit('ice_error', err));
  }

  async _hostBegin() {
    for (const label of this.channelLabels) {
      this._adopt(this.peer.createChannel(label));
    }
    const offer = await this.peer.offer();
    await this._send('offer', { sdp: offer.sdp });
  }

  /**
   * Feed a non-system signal message from the transport.
   * @param {string} name   offer|answer|ice|status
   * @param {object} payload
   * @param {string} sender host|viewer (server-recorded role — trusted)
   */
  async handleSignal(name, payload, sender) {
    if (!this._started) {
      throw new ProtocolError('negotiation not started', 'negotiation_not_started');
    }
    // Defense-in-depth: the SENDER must be allowed to emit this name
    // (the server enforces the same matrix — see shared/protocol/v1.md).
    if (!maySignal(sender, name)) {
      throw new ProtocolError(`role "${sender}" may not send "${name}"`, 'signal_role');
    }

    if (name === 'ice') {
      await this.peer.addIce(payload);
      return;
    }
    if (name === 'offer') {
      if (this.role !== 'viewer') {
        throw new ProtocolError('host does not accept offers', 'signal_direction');
      }
      if (this._answered) {
        this.emit('duplicate', { name });
        return;
      }
      const answer = await this.peer.acceptOffer(payload.sdp);
      this._answered = true;
      await this._send('answer', { sdp: answer.sdp });
      return;
    }
    if (name === 'answer') {
      if (this.role !== 'host') {
        throw new ProtocolError('viewer does not accept answers', 'signal_direction');
      }
      if (this._receivedAnswer) {
        this.emit('duplicate', { name });
        return;
      }
      this._receivedAnswer = true;
      await this.peer.acceptAnswer(payload.sdp);
    }
    // 'status' carries no negotiation meaning — sessions consume it.
  }

  _adopt(channel) {
    const label = channel.label;
    if (this.channels[label]) {
      try {
        channel.close();
      } catch { /* duplicate */ }
      return;
    }
    this.channels[label] = channel;
    channel.onopen = () => this._onChannelOpen(label);
    channel.onclose = () => this.emit('channel_closed', { label });
    if (channel.readyState === 'open') {
      this._onChannelOpen(label);
    }
    this.emit('channel', channel);
  }

  _onChannelOpen(label) {
    if (this._opened.has(label)) {
      return;
    }
    this._opened.add(label);
    if (this.channelLabels.length > 0
      && this.channelLabels.every((l) => this._opened.has(l))) {
      this.emit('ready', { channels: this.channels });
    }
  }

  _onConnected() {
    if (this._settled) {
      return;
    }
    this._settled = true;
    clearTimeout(this._timer);
    this.emit('connected');
  }

  _onFailed() {
    if (this._settled) {
      return;
    }
    if (this.role === 'host' && !this._restarted && this.peer.restartIceSupported) {
      this._restarted = true;
      this._attemptRestart();
      return;
    }
    this._fail('ice_failed');
  }

  async _attemptRestart() {
    try {
      this.logger?.info('ice_restart', { attempt: 1 });
      this.emit('ice_restart', { attempt: 1 });
      this.peer.restartIce();
      const offer = await this.peer.offer();
      await this._send('offer', { sdp: offer.sdp });
      this._armTimer(15000);
    } catch {
      this._fail('ice_restart_failed');
    }
  }

  _armTimer(ms = null) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._fail('negotiation_timeout'), ms ?? this.negotiationTimeoutMs);
  }

  _fail(reason) {
    if (this._settled) {
      return;
    }
    this._settled = true;
    clearTimeout(this._timer);
    this.logger?.warn('negotiation_failed', { reason, role: this.role });
    this.emit('failed', { reason });
  }

  async _send(name, payload) {
    try {
      await this.transport.send(name, payload);
    } catch (err) {
      this.emit('signal_error', { name, err: String(err?.message ?? err) });
      throw err;
    }
  }

  get settled() {
    return this._settled;
  }

  cleanup() {
    clearTimeout(this._timer);
    this._settled = true;
    for (const channel of Object.values(this.channels)) {
      try {
        channel.close();
      } catch { /* already closed */ }
    }
    this.channels = {};
    this._opened.clear();
  }
}

