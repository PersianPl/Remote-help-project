import { ProtocolError } from './protocol.js';

/**
 * Binary frame format for the "frames" datachannel.
 * Big-endian, 16-byte header:
 *   u8  type   (1 = frame)
 *   u8  format (0 = JPEG)
 *   u16 reserved (flags, must be 0 in v1)
 *   u32 seq    (monotonic per sender — receiver detects drops)
 *   u32 tsMs   (sender timestamp, epoch ms)
 *   u16 width
 *   u16 height
 * followed by payload bytes.
 */

export const FRAME_TYPE = 1;
export const FRAME_FORMAT_JPEG = 0;
export const FRAME_HEADER_BYTES = 16;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_DIMENSION = 8192;

export function encodeFrame({ seq, tsMs, width, height, format = FRAME_FORMAT_JPEG, data }) {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new ProtocolError('frame seq invalid', 'frame_seq');
  }
  if (!Number.isInteger(tsMs) || tsMs < 0 || tsMs > 0xffffffff) {
    throw new ProtocolError('frame ts invalid', 'frame_ts');
  }
  if (!Number.isInteger(width) || width < 1 || width > MAX_DIMENSION
    || !Number.isInteger(height) || height < 1 || height > MAX_DIMENSION) {
    throw new ProtocolError('frame dimensions invalid', 'frame_dims');
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError('frame payload size invalid', 'frame_size');
  }

  const out = new Uint8Array(FRAME_HEADER_BYTES + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_TYPE);
  view.setUint8(1, format);
  view.setUint16(2, 0);
  view.setUint32(4, seq);
  view.setUint32(8, tsMs);
  view.setUint16(12, width);
  view.setUint16(14, height);
  out.set(bytes, FRAME_HEADER_BYTES);
  return out;
}

/** @returns {{seq:number, tsMs:number, width:number, height:number, format:number, data:Uint8Array}} */
export function decodeFrame(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength <= FRAME_HEADER_BYTES) {
    throw new ProtocolError('frame too short', 'frame_short');
  }
  if (bytes.byteLength > FRAME_HEADER_BYTES + MAX_FRAME_BYTES) {
    throw new ProtocolError('frame too large', 'frame_size');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  if (type !== FRAME_TYPE) {
    throw new ProtocolError(`unknown frame type ${type}`, 'frame_type');
  }
  const format = view.getUint8(1);
  if (format !== FRAME_FORMAT_JPEG) {
    throw new ProtocolError(`unknown frame format ${format}`, 'frame_format');
  }
  const flags = view.getUint16(2);
  if (flags !== 0) {
    throw new ProtocolError('unsupported frame flags', 'frame_flags');
  }

  const seq = view.getUint32(4);
  const tsMs = view.getUint32(8);
  const width = view.getUint16(12);
  const height = view.getUint16(14);
  if (width < 1 || width > MAX_DIMENSION || height < 1 || height > MAX_DIMENSION) {
    throw new ProtocolError('frame dimensions invalid', 'frame_dims');
  }

  return {
    seq,
    tsMs,
    width,
    height,
    format,
    data: bytes.subarray(FRAME_HEADER_BYTES),
  };
}
