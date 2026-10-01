import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bgraToRgba, downscaleBgra, encodeJpeg, encodeBgraToJpeg,
  listMonitors, findMonitor, virtualDesktop,
  ScreenCapture, createScreenCapture, CaptureUnsupportedError,
} from '../src/host/capture/ScreenCapture.js';

const isWin = process.platform === 'win32';

test('bgraToRgba swaps channels and forces opaque alpha', () => {
  // two pixels: BGRA (10,20,30,0) and (40,50,60,255)
  const bgra = new Uint8Array([10, 20, 30, 0, 40, 50, 60, 255]);
  const rgba = bgraToRgba(bgra, 2, 1);
  assert.deepEqual([...rgba], [30, 20, 10, 255, 60, 50, 40, 255]);
});

test('downscaleBgra box-filters with an integer ratio', () => {
  // 4x2 image, two 2x2 blocks: very dark and very bright
  const width = 4;
  const height = 2;
  const bgra = new Uint8Array(width * height * 4);
  const set = (x, y, b, g, r) => {
    const o = (y * width + x) * 4;
    bgra[o] = b; bgra[o + 1] = g; bgra[o + 2] = r; bgra[o + 3] = 255;
  };
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(x, y, 0, 0, 0);
  for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) set(x, y, 200, 100, 50);

  const out = downscaleBgra(bgra, width, height, 2);
  assert.equal(out.scaled, true);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.equal(out.ratio, 2);
  assert.deepEqual([...out.data], [0, 0, 0, 255, 200, 100, 50, 255]);

  // No upscaling and no work when the target is already reached
  const same = downscaleBgra(bgra, width, height, 4);
  assert.equal(same.scaled, false);
  assert.equal(same.data, bgra);
});

test('encodeBgraToJpeg produces a real JPEG at the requested size', async () => {
  const width = 16;
  const height = 8;
  const bgra = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    bgra[i * 4] = 90;
    bgra[i * 4 + 1] = 140;
    bgra[i * 4 + 2] = 220;
    bgra[i * 4 + 3] = 255;
  }

  const full = await encodeBgraToJpeg(bgra, width, height, { quality: 70 });
  assert.equal(full.width, width);
  assert.equal(full.height, height);
  assert.equal(full.scaled, false);
  assert.deepEqual([...full.data.slice(0, 3)], [0xff, 0xd8, 0xff], 'JPEG SOI marker');
  assert.deepEqual([...full.data.slice(-2)], [0xff, 0xd9], 'JPEG EOI marker');

  const scaled = await encodeBgraToJpeg(bgra, width, height, { quality: 70, maxWidth: 8 });
  assert.equal(scaled.scaled, true);
  assert.equal(scaled.width, 8);
  assert.equal(scaled.height, 4);

  const single = await encodeJpeg(bgraToRgba(bgra, width, height), width, height, 50);
  assert.equal(single.quality, 50);
  assert.ok(single.data.byteLength > 0);
});

test('monitor enumeration reports the real desktop (Windows)', async (t) => {
  if (!isWin) {
    t.skip('monitor enumeration needs Windows');
    return;
  }
  const monitors = listMonitors();
  assert.ok(monitors.length >= 1, 'at least one monitor');
  assert.equal(monitors.filter((m) => m.primary).length, 1, 'exactly one primary monitor');
  for (const monitor of monitors) {
    assert.ok(monitor.width > 0 && monitor.height > 0);
    assert.ok(Number.isInteger(monitor.x) && Number.isInteger(monitor.y));
  }
  const primary = findMonitor();
  assert.equal(primary.primary, true);
  assert.equal(findMonitor({ index: 0 }).index, 0);
  assert.equal(findMonitor({ index: 999 }), null, 'unknown index is not silently remapped');

  const desktop = virtualDesktop();
  assert.ok(desktop.width >= primary.width);
  const whole = findMonitor({ useVirtualDesktop: true });
  assert.equal(whole.index, -1);
  assert.equal(whole.width, desktop.width);

  // A point inside the primary monitor resolves to it
  const inside = findMonitor({ x: primary.x + 1, y: primary.y + 1 });
  assert.equal(inside.width, primary.width);
});

test('ScreenCapture grabs a real JPEG frame and releases GDI handles', async (t) => {
  if (!isWin) {
    await assert.rejects(() => createScreenCapture(), CaptureUnsupportedError);
    t.skip('GDI capture needs Windows');
    return;
  }
  const capture = await createScreenCapture({ maxWidth: 960, quality: 55 });
  const primary = findMonitor();
  assert.equal(capture.bounds.width, primary.width);
  assert.equal(capture.bounds.height, primary.height);

  const raw = capture.grabRaw();
  assert.equal(raw.bgra.length, raw.width * raw.height * 4, 'full BGRA surface');
  assert.ok(raw.captureMs >= 0);

  const frame = await capture.grab();
  assert.equal(frame.width, 960, 'downscaled to maxWidth');
  assert.ok(frame.height > 0 && frame.height < primary.height);
  assert.deepEqual([...frame.data.slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(frame.data.byteLength > 1000, 'a real screen compresses to more than a few bytes');
  assert.equal(capture.stats.frames, 1);

  const second = await capture.grab();
  assert.equal(capture.stats.frames, 2, 'the DIB section is reusable across frames');
  assert.ok(second.data.byteLength > 0);

  capture.close();
  assert.throws(() => capture.grabRaw(), /capture session is closed/);
  capture.close(); // idempotent
});
