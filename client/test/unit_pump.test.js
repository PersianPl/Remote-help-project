import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FramePump } from '../src/host/FramePump.js';

/** Fake session that can pretend the channel is congested. */
function fakeSession({ accept = true } = {}) {
  return {
    sent: [],
    sendFrame(frame) {
      if (!accept) {
        return false;
      }
      this.sent.push(frame);
      return true;
    },
  };
}

function fakeCapture({ width = 64, height = 48 } = {}) {
  const state = { grabs: 0 };
  return {
    state,
    async grab() {
      state.grabs += 1;
      return {
        width,
        height,
        data: Uint8Array.from([0xff, 0xd8, 0xff, state.grabs & 0xff]),
        tsMs: Date.now(),
        captureMs: 1,
        encodeMs: 2,
      };
    },
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('FramePump streams at the target rate and stops cleanly', async () => {
  const session = fakeSession();
  const capture = fakeCapture();
  const pump = new FramePump(session, capture, { fps: 25 });
  const frames = [];
  pump.on('frame', (frame) => frames.push(frame));

  assert.equal(pump.setFps(40), 30, 'fps is clamped to 30');
  pump.setFps(20);
  assert.equal(pump.intervalMs, 50);

  pump.start();
  await sleep(320);
  pump.stop();
  await sleep(30);

  assert.ok(pump.stats.pumped >= 4, `expected several frames, got ${pump.stats.pumped}`);
  assert.equal(pump.stats.dropped, 0);
  assert.equal(pump.stats.errors, 0);
  assert.equal(frames.length, pump.stats.pumped);
  assert.equal(pump.stats.bytes, frames.reduce((sum, f) => sum + f.data.byteLength, 0));
  assert.ok(pump.stats.lastFps > 0, 'measured fps is reported');
  assert.equal(pump.running, false, 'stop() ends the loop');
  assert.ok(pump.diagnostics().avgKbps >= 0);

  const afterStop = pump.stats.pumped;
  await sleep(120);
  assert.equal(pump.stats.pumped, afterStop, 'not a single frame after stop()');
});

test('FramePump drops (never queues) when the channel is congested', async () => {
  const session = fakeSession({ accept: false });
  const capture = fakeCapture();
  const pump = new FramePump(session, capture, { fps: 25 });
  const drops = [];
  pump.on('drop', (info) => drops.push(info));

  pump.start();
  await sleep(220);
  pump.stop();

  assert.equal(session.sent.length, 0, 'nothing was handed to the channel');
  assert.ok(pump.stats.dropped >= 3, `expected drops, got ${pump.stats.dropped}`);
  assert.equal(pump.stats.pumped, 0);
  assert.equal(drops[0].reason, 'congested');
});

test('FramePump pause/resume holds and restarts the loop', async () => {
  const session = fakeSession();
  const capture = fakeCapture();
  const pump = new FramePump(session, capture, { fps: 25 });
  const states = [];
  pump.on('paused', (value) => states.push(value));

  pump.start();
  await sleep(120);
  pump.pause();
  await sleep(30);
  const whilePaused = pump.stats.pumped;
  await sleep(160);
  assert.equal(pump.stats.pumped, whilePaused, 'paused pump produced nothing');

  pump.resume();
  await sleep(160);
  pump.stop();

  assert.ok(pump.stats.pumped > whilePaused, 'resume continues streaming');
  assert.deepEqual(states, [true, false]);

  pump.start(); // start() after stop() is allowed (same session, re-armed)
  await sleep(100);
  pump.stop();
  assert.equal(pump.running, false);
});
