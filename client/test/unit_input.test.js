import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  keyToVk, planMouse, planKey, plan, InputInjector, InputRefusedError,
  PlatformUnsupportedError, MOUSEEVENTF, KEYEVENTF, createInputInjector,
} from '../src/host/input/InputInjector.js';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };
const env = { screen, monitor: { x: 0, y: 0, width: 1920, height: 1080 } };

test('keyToVk maps US characters and named keys (layout independent)', () => {
  assert.deepEqual(keyToVk('a'), { vk: 0x41, shift: false, extended: false });
  assert.deepEqual(keyToVk('A'), { vk: 0x41, shift: true, extended: false });
  assert.deepEqual(keyToVk('7'), { vk: 0x37, shift: false, extended: false });
  assert.deepEqual(keyToVk('!'), { vk: 0x31, shift: true, extended: false });
  assert.deepEqual(keyToVk(';'), { vk: 0xBA, shift: false, extended: false });
  assert.deepEqual(keyToVk('enter'), { vk: 0x0D, shift: false, extended: false });
  assert.deepEqual(keyToVk('Tab'), { vk: 0x09, shift: false, extended: false });
  assert.deepEqual(keyToVk('f5'), { vk: 0x74, shift: false, extended: false });
  // arrows/editing keys need the extended-key flag or they arrive as numpad keys
  assert.deepEqual(keyToVk('left'), { vk: 0x25, shift: false, extended: true });
  assert.equal(keyToVk('pgdn').extended, true);
  assert.equal(keyToVk('delete').extended, true);
});

test('keyToVk refuses blocked, unmappable and empty keys', () => {
  for (const banned of ['lwin', 'win', 'meta', 'altf4', 'ctrl+alt+del']) {
    assert.throws(() => keyToVk(banned), (err) => {
      assert.ok(err instanceof InputRefusedError);
      assert.equal(err.code, 'input_blocked_key');
      return true;
    });
  }
  assert.throws(() => keyToVk('nope'), /cannot be mapped/);
  assert.throws(() => keyToVk(''), /empty key name/);
  // non-ASCII is never in the US table
  assert.throws(() => keyToVk('ش'), /cannot be mapped/);
});

test('planMouse maps monitor-local pixels to absolute virtual-desktop coords', () => {
  // Endpoints are exact: 0 → 0 and (w-1) → 65535.
  const origin = planMouse({ action: 'move', x: 0, y: 0 }, env);
  assert.equal(origin[0].dx, 0);
  assert.equal(origin[0].dy, 0);

  const corner = planMouse({ action: 'move', x: 1919, y: 1079 }, env);
  assert.equal(corner[0].dx, 65535);
  assert.equal(corner[0].dy, 65535);

  // Middle of the screen lands near the middle of the normalized range.
  const center = planMouse({ action: 'move', x: 960, y: 540 }, env);
  assert.ok(Math.abs(center[0].dx - 32768) <= 50, `dx was ${center[0].dx}`);
  assert.ok(Math.abs(center[0].dy - 32768) <= 50, `dy was ${center[0].dy}`);
  assert.equal(center[0].flags, MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK);

  // Second monitor: its own local origin is not the desktop origin.
  const wide = { screen: { x: 0, y: 0, width: 3840, height: 1080 }, monitor: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const onRightMonitor = planMouse({ action: 'move', x: 0, y: 0 }, wide);
  assert.ok(Math.abs(onRightMonitor[0].dx - 32768) <= 20, `dx was ${onRightMonitor[0].dx}`);

  // Negative virtual-desktop origin clamps at 0 instead of wrapping.
  const negative = { screen: { x: -1920, y: 0, width: 3840, height: 1080 }, monitor: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const topLeft = planMouse({ action: 'move', x: 0, y: 0 }, negative);
  assert.equal(topLeft[0].dx, 0, 'left of primary virtual desktop clamps at 0');
});

test('planMouse covers buttons, dblclick and wheel', () => {
  const down = planMouse({ action: 'down', x: 1, y: 1, button: 'right' }, env);
  assert.equal(down[0].flags & MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTDOWN);

  const up = planMouse({ action: 'up', x: 1, y: 1, button: 'middle' }, env);
  assert.equal(up[0].flags & MOUSEEVENTF.MIDDLEUP, MOUSEEVENTF.MIDDLEUP);

  const dbl = planMouse({ action: 'dblclick', x: 2, y: 2, button: 'left' }, env);
  assert.equal(dbl.length, 4);
  assert.deepEqual(
    dbl.map((e) => e.flags & (MOUSEEVENTF.LEFTDOWN | MOUSEEVENTF.LEFTUP)),
    [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP, MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP]
  );

  const wheel = planMouse({ action: 'wheel', x: 3, y: 3, delta: -120 }, env);
  assert.equal(wheel[0].flags & MOUSEEVENTF.WHEEL, MOUSEEVENTF.WHEEL);
  assert.equal(wheel[0].mouseData, (-120) >>> 0, 'wheel delta keeps its signed bit pattern');

  assert.throws(() => planMouse({ action: 'launch_missiles', x: 0, y: 0 }, env), /unknown mouse action/);
});

test('planKey wraps modifiers around the key and releases them in reverse', () => {
  const combo = planKey({ t: 'input', kind: 'key', action: 'down', key: 'c', modifiers: { ctrl: true } });
  assert.deepEqual(combo, [
    { kind: 'key', vk: 0x11, up: false, extended: false },
    { kind: 'key', vk: 0x43, up: false, extended: false },
  ]);

  const release = planKey({ t: 'input', kind: 'key', action: 'up', key: 'c', modifiers: { ctrl: true, alt: true } });
  assert.deepEqual(release, [
    { kind: 'key', vk: 0x43, up: true, extended: false },
    { kind: 'key', vk: 0x12, up: true, extended: false },
    { kind: 'key', vk: 0x11, up: true, extended: false },
  ], 'key released first, then modifiers');

  // A character that needs Shift gets it even if the viewer forgot the modifier
  const bang = planKey({ t: 'input', kind: 'key', action: 'down', key: '!', modifiers: {} });
  assert.deepEqual(bang.map((e) => e.vk), [0x10, 0x31]);

  // Shift-held letters keep producing the requested character
  const upper = planKey({ t: 'input', kind: 'key', action: 'down', key: 'A', modifiers: { shift: true } });
  assert.deepEqual(upper.map((e) => e.vk), [0x10, 0x41]);
  assert.equal(upper.filter((e) => e.vk === 0x10).length, 1, 'shift never doubled');

  assert.equal(planKey({ t: 'input', kind: 'key', action: 'down', key: 'left', modifiers: {} })[0].extended, true);
  assert.throws(() => planKey({ t: 'input', kind: 'key', action: 'down', key: 'win', modifiers: {} }), /blocklist/);
});

test('plan() dispatches and rejects malformed messages', () => {
  assert.equal(plan({ t: 'input', kind: 'mouse', action: 'move', x: 1, y: 1 }, env).length, 1);
  assert.equal(plan({ t: 'input', kind: 'key', action: 'down', key: 'a', modifiers: {} }, env).length, 1);
  assert.throws(() => plan({ kind: 'mouse' }, env), /shape is invalid/);
  assert.throws(() => plan({ t: 'input', kind: 'touch', action: 'tap' }, env), /unknown input kind/);
  assert.throws(() => plan(null, env), /shape is invalid/);
});

test('InputInjector.apply sends a planned event batch through its win32 binding', () => {
  const sent = [];
  const fakeWin = {
    metrics: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    send: (events) => sent.push(...events),
  };
  const injector = new InputInjector(fakeWin);

  const result = injector.apply({ t: 'input', kind: 'key', action: 'down', key: 'c', modifiers: { ctrl: true } });
  assert.equal(result.applied, 2);
  assert.deepEqual(sent.map((e) => e.vk), [0x11, 0x43]);
  assert.equal(injector.stats.applied, 1);
  assert.equal(injector.stats.events, 2);

  assert.throws(() => injector.apply({ t: 'input', kind: 'key', action: 'down', key: 'lwin' }), /blocklist/);
  assert.equal(injector.stats.refused, 1, 'refusals are counted, nothing is sent');
  assert.equal(sent.length, 2, 'no event reached the binding for a blocked key');

  const failing = new InputInjector({ metrics: () => screen, send: () => { throw new Error('SendInput injected 1/2 events'); } });
  assert.throws(() => failing.apply({ t: 'input', kind: 'mouse', action: 'move', x: 1, y: 1 }), /SendInput injected/);
  assert.equal(failing.stats.failed, 1);
});

test('InputInjector.create() loads user32 on Windows and reports the desktop rect', async (t) => {
  if (!InputInjector.isSupported()) {
    await assert.rejects(() => createInputInjector(), PlatformUnsupportedError);
    t.skip('not running on Windows');
    return;
  }
  const injector = await createInputInjector();
  const desktop = injector.screen;
  assert.ok(desktop.width >= 640, `desktop width ${desktop.width}`);
  assert.ok(desktop.height >= 480, `desktop height ${desktop.height}`);
  injector.setMonitor({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(injector.env().monitor.width, 1920);
  assert.equal(injector.win.inputSize, 40, 'INPUT struct must be 40 bytes on x64');
});

// Opt-in live check: really calls user32!SendInput (moves the cursor to the
// virtual desktop center and back). Enable deliberately:
//   $env:RH_INJECT_SMOKE='1'; node --test test/unit_input.test.js
test('live SendInput smoke test (opt-in via RH_INJECT_SMOKE=1)', async (t) => {
  if (process.env.RH_INJECT_SMOKE !== '1' || !InputInjector.isSupported()) {
    t.skip('set RH_INJECT_SMOKE=1 to run the visible live injection check');
    return;
  }
  const injector = await createInputInjector();
  const desktop = injector.screen;
  const center = { x: Math.floor(desktop.width / 2) - desktop.x, y: Math.floor(desktop.height / 2) - desktop.y };
  const stored = injector.apply({ t: 'input', kind: 'mouse', action: 'move', ...center });
  assert.equal(stored.applied, 1);
  assert.equal(injector.stats.applied, 1);
});
