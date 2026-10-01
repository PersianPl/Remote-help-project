import { Emitter } from './emitter.js';
import { encodeFrame, decodeFrame } from './frame.js';
import { ProtocolError } from './protocol.js';

/**
 * Frame pipeline over a WebRTC datachannel (stage 8).
 *
 * Real P2P transport path: Desktop Capture → JPEG encode → FrameSender →
 * WebRTC DataChannel → FrameReceiver → render. The backend never sees a
 * single frame. Sender drops frames instead of queueing when the channel
 * is congested (correct policy for screen sharing).
 */

const now = () => Date.now();

function toWireBytes(uint8) {
  return typeof Buffer !== 'undefined'
    ? Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength)
    : uint8;
}

function fromWire(data) {
  if (typeof data === 'string') {
    return null; // frames are binary-only on the frames channel
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

export class FrameSender extends Emitter {
  constructor(channel, { highWaterMark = 1024 * 1024 } = {}) {
    super();
    this.channel = channel;
    this.highWaterMark = highWaterMark;
    this.seq = 0;
    this.stats = { sent: 0, dropped: 0, bytes: 0 };
  }

  /** @returns {boolean} true if the frame was handed to the channel */
  send({ width, height, data, tsMs = now() }) {
    if (this.channel.readyState !== 'open') {
      this.stats.dropped += 1;
      return false;
    }
    if (this.channel.bufferedAmount > this.highWaterMark) {
      // Congestion → drop this frame, never grow the buffer (stage 18).
      this.stats.dropped += 1;
      this.emit('drop', { bufferedAmount: this.channel.bufferedAmount });
      return false;
    }
    const frame = encodeFrame({
      seq: this.seq % 0x100000000,
      tsMs: tsMs % 0x100000000,
      width,
      height,
      data,
    });
    this.seq += 1;
    this.channel.send(toWireBytes(frame));
    this.stats.sent += 1;
    this.stats.bytes += frame.byteLength;
    return true;
  }
}

export class FrameReceiver extends Emitter {
  constructor(channel, { windowMs = 2000 } = {}) {
    super();
    this.channel = channel;
    this.windowMs = windowMs;
    this.lastSeq = null;
    this.frameTimes = [];
    this.stats = { received: 0, bytes: 0, lost: 0, invalid: 0, fps: 0, kbps: 0 };
    this._bytesWindow = [];
    this._onMessage = (event) => this._handle(event?.data ?? event);
    if (typeof channel.addEventListener === 'function') {
      channel.addEventListener('message', this._onMessage);
      channel.onmessage = null;
    } else {
      channel.onmessage = this._onMessage;
    }
  }

  _handle(raw) {
    const bytes = fromWire(raw);
    if (!bytes) {
      this.stats.invalid += 1;
      this.emit('invalid', { reason: 'non_binary' });
      return;
    }
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      this.stats.invalid += 1;
      this.emit('invalid', { reason: err instanceof ProtocolError ? err.code : 'decode' });
      return;
    }

    if (this.lastSeq !== null && frame.seq > this.lastSeq + 1) {
      this.stats.lost += frame.seq - this.lastSeq - 1;
    }
    this.lastSeq = frame.seq;

    this.stats.received += 1;
    this.stats.bytes += bytes.byteLength;

    const ts = now();
    this.frameTimes.push(ts);
    this._bytesWindow.push({ ts, bytes: bytes.byteLength });
    this._prune(ts);

    const fps = this.frameTimes.length * (1000 / this.windowMs);
    const kbps = this._bytesWindow.reduce((sum, e) => sum + e.bytes, 0) * 8 / this.windowMs;
    this.stats.fps = Math.round(fps * 10) / 10;
    this.stats.kbps = Math.round(kbps);

    this.emit('frame', {
      seq: frame.seq,
      tsMs: frame.tsMs,
      width: frame.width,
      height: frame.height,
      data: frame.data,
    });
  }

  _prune(ts) {
    const cutoff = ts - this.windowMs;
    while (this.frameTimes.length && this.frameTimes[0] < cutoff) {
      this.frameTimes.shift();
    }
    while (this._bytesWindow.length && this._bytesWindow[0].ts < cutoff) {
      this._bytesWindow.shift();
    }
  }

  detach() {
    if (typeof this.channel.removeEventListener === 'function') {
      this.channel.removeEventListener('message', this._onMessage);
    }
    this.channel.onmessage = null;
  }
}
