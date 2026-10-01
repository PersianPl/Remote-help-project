import { Emitter } from './emitter.js';

/**
 * PeerConnection wrapper (stage 3): one uniform surface over the browser's
 * native RTCPeerConnection and werift (Node). Application code never
 * touches the underlying implementation directly.
 */

const hasBrowserRTC = typeof RTCPeerConnection !== 'undefined';

export async function createPeerConnection(iceConfig) {
  if (hasBrowserRTC) {
    return new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy,
    });
  }
  const { RTCPeerConnection } = await import('werift');
  return new RTCPeerConnection({
    iceServers: iceConfig.iceServers,
    iceTransportPolicy: iceConfig.iceTransportPolicy,
  });
}

export class Peer extends Emitter {
  constructor(pc) {
    super();
    this.pc = pc;
    this._pendingRemoteIce = [];
    this._channelLabelSeq = 0;
    this._wire();
  }

  static async create(iceConfig) {
    return new Peer(await createPeerConnection(iceConfig));
  }

  _wire() {
    const pc = this.pc;
    pc.onconnectionstatechange = () => this.emit('state', pc.connectionState);
    pc.onicecandidate = (event) => {
      const candidate = event?.candidate;
      if (!candidate) {
        return; // end-of-candidate is not trickled in v1 (documented)
      }
      const init = typeof candidate === 'string'
        ? { candidate, sdpMid: '0', sdpMLineIndex: 0 }
        : {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid ?? '0',
            sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
          };
      this.emit('ice', init);
    };
    pc.ondatachannel = (event) => {
      const channel = event?.channel ?? event;
      if (channel) {
        this.emit('channel', channel);
      }
    };
  }

  get state() {
    return this.pc.connectionState;
  }

  get restartIceSupported() {
    return typeof this.pc.restartIce === 'function';
  }

  restartIce() {
    this.pc.restartIce();
  }

  /** Host creates data channels before the initial offer. */
  createChannel(label, options = {}) {
    return this.pc.createDataChannel(label, options);
  }

  async offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const desc = this.pc.localDescription ?? offer;
    return { sdp: desc.sdp, type: desc.type ?? 'offer' };
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this._flushRemoteIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const desc = this.pc.localDescription ?? answer;
    return { sdp: desc.sdp, type: desc.type ?? 'answer' };
  }

  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    await this._flushRemoteIce();
  }

  /** Remote ICE may arrive before the remote description — buffer it. */
  async addIce(init) {
    if (!init || typeof init.candidate !== 'string' || init.candidate === '') {
      return;
    }
    if (!this.pc.remoteDescription) {
      this._pendingRemoteIce.push(init);
      if (this._pendingRemoteIce.length > 64) {
        this._pendingRemoteIce.shift(); // bounded (stage 18)
      }
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch (err) {
      this.emit('ice_error', err);
    }
  }

  async _flushRemoteIce() {
    const pending = this._pendingRemoteIce.splice(0);
    for (const init of pending) {
      try {
        await this.pc.addIceCandidate(init);
      } catch (err) {
        this.emit('ice_error', err);
      }
    }
  }

  close() {
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.removeAll();
  }
}
