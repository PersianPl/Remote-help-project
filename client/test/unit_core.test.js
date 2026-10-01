import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION, canTransition, maySignal, parseInputMessage, ProtocolError,
} from '../src/core/protocol.js';
import { encodeFrame, decodeFrame, FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from '../src/core/frame.js';

test('protocol version is 1', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test('transition table matches the server contract', () => {
  assert.equal(canTransition('waiting', 'join_requested'), true);
  assert.equal(canTransition('waiting', 'closed'), true);
  assert.equal(canTransition('waiting', 'connected'), false, 'no illegal jump');
  assert.equal(canTransition('join_requested', 'approved'), true);
  assert.equal(canTransition('approved', 'connected'), false, 'must pass negotiating');
  assert.equal(canTransition('negotiating', 'connected'), true);
  assert.equal(canTransition('closed', 'waiting'), false, 'final stays final');
  assert.equal(canTransition('expired', 'approved'), false);
});

test('role matrix mirrors the server', () => {
  assert.equal(maySignal('host', 'offer'), true);
  assert.equal(maySignal('viewer', 'offer'), false);
  assert.equal(maySignal('viewer', 'answer'), true);
  assert.equal(maySignal('host', 'answer'), false);
  assert.equal(maySignal('host', 'ice'), true);
  assert.equal(maySignal('viewer', 'status'), true);
});

test('input: valid mouse messages normalize', () => {
  const move = parseInputMessage(JSON.stringify({ t: 'input', kind: 'mouse', action: 'move', x: 10.6, y: 20 }));
  assert.deepEqual(move, { kind: 'mouse', action: 'move', x: 11, y: 20 });

  const wheel = parseInputMessage(JSON.stringify({ t: 'input', kind: 'mouse', action: 'wheel', x: 1, y: 1, delta: -120 }));
  assert.equal(wheel.delta, -120);
});

test('input: bounds and malformed data are rejected with codes', () => {
  const bounds = { width: 1000, height: 800 };
  const cases = [
    [JSON.stringify({ t: 'input', kind: 'mouse', action: 'move', x: 5000, y: 10 }), 'input_bounds'],
    [JSON.stringify({ t: 'input', kind: 'mouse', action: 'explode', x: 1, y: 1 }), 'input_action'],
    [JSON.stringify({ t: 'input', kind: 'mouse', action: 'move', x: 'NaN', y: 1 }), 'input_bounds'],
    [JSON.stringify({ t: 'input', kind: 'key', action: 'down', key: 'win' }), 'input_blocked_key'],
    [JSON.stringify({ t: 'input', kind: 'key', action: 'down', key: 'a', modifiers: { meta: true } }), 'input_blocked_modifier'],
    [JSON.stringify({ t: 'input', kind: 'key', action: 'down', key: 'a\u0007' }), 'input_key'],
    ['{not json', 'input_json'],
    [JSON.stringify({ t: 'other' }), 'input_shape'],
  ];
  for (const [raw, expected] of cases) {
    assert.throws(() => parseInputMessage(raw, bounds), (err) => {
      assert.ok(err instanceof ProtocolError, `ProtocolError expected for ${raw}`);
      assert.equal(err.code, expected, `expected ${expected}, got ${err.code} for ${raw}`);
      return true;
    });
  }
  assert.throws(() => parseInputMessage('x'.repeat(2000), bounds), /too large/);
});

test('frame codec roundtrips and validates', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const encoded = encodeFrame({ seq: 42, tsMs: 1234, width: 1280, height: 720, data: payload });
  assert.equal(encoded.byteLength, FRAME_HEADER_BYTES + payload.byteLength);

  const decoded = decodeFrame(encoded);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.tsMs, 1234);
  assert.equal(decoded.width, 1280);
  assert.equal(decoded.height, 720);
  assert.deepEqual([...decoded.data], [1, 2, 3, 4, 5]);

  assert.throws(() => decodeFrame(new Uint8Array(4)), /too short/);
  assert.throws(() => encodeFrame({ seq: 1, tsMs: 1, width: 0, height: 10, data: payload }), /dimensions/);
  assert.throws(
    () => encodeFrame({ seq: 1, tsMs: 1, width: 10, height: 10, data: new Uint8Array(MAX_FRAME_BYTES + 1) }),
    /payload size/
  );
  const wrongType = encoded.slice();
  wrongType[0] = 9;
  assert.throws(() => decodeFrame(wrongType), /unknown frame type/);
});

test('ice config: validation and secret-safe summary', async () => {
  const { loadIceConfig, describeIceConfig, IceConfigError } = await import('../src/core/iceConfig.js');

  const empty = loadIceConfig(null);
  assert.deepEqual(empty.iceServers, []);

  assert.throws(() => loadIceConfig({ iceServers: [{ urls: 'stun:x:1', username: 'u', credential: 'p' }] }), IceConfigError);
  assert.throws(() => loadIceConfig({ iceServers: [{ urls: 'turn:x:1' }] }), IceConfigError);
  assert.throws(() => loadIceConfig({ iceServers: [{ urls: 'http://bad' }] }), IceConfigError);
  assert.throws(() => loadIceConfig({ iceTransportPolicy: 'nope' }), IceConfigError);

  const turn = loadIceConfig({ iceServers: [{ urls: ['turn:t:3478'], username: 'u', credential: 'super-secret' }] });
  const summary = describeIceConfig(turn);
  assert.equal(summary.turn, 1);
  assert.equal(summary.stun, 0);
  assert.ok(!JSON.stringify(summary).includes('super-secret'), 'summary must never contain credentials');
});

test('input policy: explicit approval, validation and rate limit', async () => {
  const { InputPolicy } = await import('../src/core/InputPolicy.js');
  const policy = new InputPolicy({ bounds: { width: 800, height: 600 }, maxRatePerSec: 2, burst: 2 });
  const raw = JSON.stringify({ t: 'input', kind: 'mouse', action: 'move', x: 5, y: 5 });

  assert.equal(policy.accept(raw).ok, false, 'disabled by default (stage 11)');
  assert.equal(policy.accept(raw).reason, 'input_disabled');

  policy.enable();
  assert.equal(policy.accept(raw).ok, true);
  assert.equal(policy.accept(raw).ok, true);
  assert.equal(policy.accept(raw).reason, 'rate_limited', 'burst exhausted');

  const bad = policy.accept(JSON.stringify({ t: 'input', kind: 'mouse', action: 'move', x: 9999, y: 1 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'input_bounds');

  policy.disable();
  assert.equal(policy.accept(raw).reason, 'input_disabled');
  assert.ok(policy.stats.accepted >= 2);
  assert.ok(policy.stats.rejected >= 2);
});

test('logger masks secrets and respects level', async () => {
  const { Logger } = await import('../src/core/logger.js');
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (line) => lines.push(line) });

  logger.info('session', { host_token: 'aaaabbbbcccc', human_code: '583-241', state: 'waiting', nested: { authorization: 'x' } });
  assert.ok(lines[0].includes('[redacted]'), 'token masked');
  assert.ok(!lines[0].includes('aaaabbbbcccc'), 'raw token absent');
  assert.ok(!lines[0].includes('583-241'), 'session code absent');
  assert.ok(lines[0].includes('state=waiting'), 'non-sensitive kept');

  const quiet = [];
  const infoOnly = new Logger({ level: 'info', sink: (l) => quiet.push(l) });
  infoOnly.debug('hidden', {});
  infoOnly.error('shown', {});
  assert.equal(quiet.length, 1, 'debug filtered at info level');
});
