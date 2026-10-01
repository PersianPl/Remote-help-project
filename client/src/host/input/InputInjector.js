import { BLOCKED_KEYS } from '../../core/protocol.js';

/**
 * Host-side Windows input injection (stage 10) — koffi → user32!SendInput.
 *
 * Design rules:
 * - This module ONLY ever receives messages already accepted by InputPolicy
 *   (explicit host approval + schema validation + rate limiting).
 * - Planning is pure and fully unit-testable (plan()/planMouse()/planKey());
 *   execution (SendInput) is a thin, separate step.
 * - Layout independence: the machine may run any keyboard layout, so
 *   characters are mapped through a static US VK table instead of the
 *   layout-dependent VkKeyScanW (verified: VkKeyScanW('a') === -1 on a
 *   non-Latin layout, which would silently break typing).
 * - Blocked keys (Win/meta and friends) are re-checked here as the last
 *   line of defense and never reach SendInput.
 */

export class PlatformUnsupportedError extends Error {
  constructor(message = 'input injection is only supported on Windows (user32!SendInput)') {
    super(message);
    this.name = 'PlatformUnsupportedError';
    this.code = 'platform_unsupported';
  }
}

export class InputRefusedError extends Error {
  constructor(message, code = 'input_refused') {
    super(message);
    this.name = 'InputRefusedError';
    this.code = code;
  }
}

// --- Win32 constants ---------------------------------------------------------

export const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800,
  ABSOLUTE: 0x8000, VIRTUALDESK: 0x4000,
});

export const KEYEVENTF = Object.freeze({
  EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008,
});

export const VK = Object.freeze({
  SHIFT: 0x10, CTRL: 0x11, ALT: 0x12,
  BACK: 0x08, TAB: 0x09, RETURN: 0x0D, ESCAPE: 0x1B, SPACE: 0x20,
  PRIOR: 0x21, NEXT: 0x22, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  INSERT: 0x2D, DELETE: 0x2E,
});

/** Keys whose KEYEVENTF_EXTENDEDKEY flag must be set. */
const EXTENDED_VKS = new Set([
  VK.PRIOR, VK.NEXT, VK.END, VK.HOME, VK.LEFT, VK.UP, VK.RIGHT, VK.DOWN,
  VK.INSERT, VK.DELETE,
]);

const NAMED_KEYS = Object.freeze({
  enter: VK.RETURN, return: VK.RETURN, cr: VK.RETURN,
  tab: VK.TAB, esc: VK.ESCAPE, escape: VK.ESCAPE, backspace: VK.BACK,
  space: VK.SPACE, spacebar: VK.SPACE,
  delete: VK.DELETE, del: VK.DELETE, insert: VK.INSERT, ins: VK.INSERT,
  home: VK.HOME, end: VK.END,
  pageup: VK.PRIOR, pgup: VK.PRIOR, pagedown: VK.NEXT, pgdn: VK.NEXT,
  left: VK.LEFT, up: VK.UP, right: VK.RIGHT, down: VK.DOWN,
  arrowleft: VK.LEFT, arrowup: VK.UP, arrowright: VK.RIGHT, arrowdown: VK.DOWN,
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
});

/**
 * US-layout base VK table: character → { vk, shift }.
 * `shift: true` means the character physically needs Shift on a US layout.
 */
const CHAR_VK = (() => {
  const table = {};
  const add = (chars, vk, shift) => {
    for (const ch of chars) {
      table[ch] = { vk, shift };
    }
  };
  'abcdefghijklmnopqrstuvwxyz'.split('').forEach((ch, i) => {
    add([ch], 0x41 + i, false);
    add([ch.toUpperCase()], 0x41 + i, true);
  });
  '0123456789'.split('').forEach((ch, i) => {
    add([ch], 0x30 + i, false);
  });
  add([')'], 0x30, true);
  add(['!'], 0x31, true);
  add(['@'], 0x32, true);
  add(['#'], 0x33, true);
  add(['$'], 0x34, true);
  add(['%'], 0x35, true);
  add(['^'], 0x36, true);
  add(['&'], 0x37, true);
  add(['*'], 0x38, true);
  add(['('], 0x39, true);
  add([' '], VK.SPACE, false);
  add(['-'], 0xBD, false);
  add(['_'], 0xBD, true);
  add(['='], 0xBB, false);
  add(['+'], 0xBB, true);
  add(['['], 0xDB, false);
  add(['{'], 0xDB, true);
  add([']'], 0xDD, false);
  add(['}'], 0xDD, true);
  add(['\\'], 0xDC, false);
  add(['|'], 0xDC, true);
  add([';'], 0xBA, false);
  add([':'], 0xBA, true);
  add(["'"], 0xDE, false);
  add(['"'], 0xDE, true);
  add([','], 0xBC, false);
  add(['<'], 0xBC, true);
  add(['.'], 0xBE, false);
  add(['>'], 0xBE, true);
  add(['/'], 0xBF, false);
  add(['?'], 0xBF, true);
  add(['`'], 0xC0, false);
  add(['~'], 0xC0, true);
  return Object.freeze(table);
})();

/**
 * Character or key name → { vk, shift, extended }.
 * @throws {InputRefusedError} for blocked/unmappable keys
 */
export function keyToVk(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InputRefusedError('empty key name', 'input_key');
  }
  const lower = key.toLowerCase();
  if (BLOCKED_KEYS.includes(lower)) {
    throw new InputRefusedError(`key "${key}" is on the permanent blocklist`, 'input_blocked_key');
  }
  const named = NAMED_KEYS[lower];
  if (named !== undefined) {
    return { vk: named, shift: false, extended: EXTENDED_VKS.has(named) };
  }
  const char = key.length === 1 ? CHAR_VK[key] : undefined;
  if (!char) {
    throw new InputRefusedError(`key "${key}" cannot be mapped to a virtual key`, 'input_unmappable');
  }
  return { vk: char.vk, shift: char.shift, extended: false };
}

// --- Pure planning (unit-testable, no OS calls) ------------------------------

/**
 * @param {object} msg validated mouse message
 * @param {{screen:{x,y,width,height}, monitor:{x,y,width,height}}} env
 * @returns {Array<{kind:'mouse', flags:number, dx:number, dy:number, mouseData:number}>}
 */
export function planMouse(msg, env) {
  const screen = env.screen;
  const monitor = env.monitor ?? { x: 0, y: 0, width: screen.width, height: screen.height };
  const width = Math.max(2, screen.width);
  const height = Math.max(2, screen.height);
  const absX = Math.round((((monitor.x + msg.x) - screen.x) * 65535) / (width - 1));
  const absY = Math.round((((monitor.y + msg.y) - screen.y) * 65535) / (height - 1));
  const clamp = (v) => Math.max(0, Math.min(65535, v));
  const position = MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK;

  const at = (flags, mouseData = 0) => ({
    kind: 'mouse', flags, dx: clamp(absX), dy: clamp(absY), mouseData,
  });

  const buttons = {
    left: [MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP],
    right: [MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP],
    middle: [MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP],
  };

  switch (msg.action) {
    case 'move':
      return [at(position)];
    case 'down':
      return [at(position | buttons[msg.button ?? 'left'][0])];
    case 'up':
      return [at(position | buttons[msg.button ?? 'left'][1])];
    case 'dblclick': {
      const [down, up] = buttons[msg.button ?? 'left'];
      return [
        at(position | down), at(position | up),
        at(position | down), at(position | up),
      ];
    }
    case 'wheel':
      return [at(position | MOUSEEVENTF.WHEEL, (msg.delta ?? 0) >>> 0)];
    default:
      throw new InputRefusedError(`unknown mouse action "${msg.action}"`, 'input_action');
  }
}

/**
 * Modifier presses are emitted around the key event; for an 'up' action the
 * release order is reversed so no modifier stays stuck down.
 * @returns {Array<{kind:'key', vk:number, up:boolean, extended:boolean}>}
 */
export function planKey(msg) {
  const target = keyToVk(msg.key);
  const mods = msg.modifiers ?? {};
  const press = [];
  if (mods.ctrl === true) press.push(VK.CTRL);
  if (mods.alt === true) press.push(VK.ALT);
  if (target.shift || mods.shift === true) press.push(VK.SHIFT);

  const keyEvent = { kind: 'key', vk: target.vk, up: msg.action === 'up', extended: target.extended };
  const downMods = press.map((vk) => ({ kind: 'key', vk, up: false, extended: false }));
  const upMods = press.slice().reverse().map((vk) => ({ kind: 'key', vk, up: true, extended: false }));

  return msg.action === 'up'
    ? [keyEvent, ...upMods]
    : [...downMods, keyEvent];
}

/** Dispatch a validated input message to an event plan. */
export function plan(msg, env) {
  if (msg === null || typeof msg !== 'object' || msg.t !== 'input') {
    throw new InputRefusedError('input message shape is invalid', 'input_shape');
  }
  if (msg.kind === 'mouse') {
    return planMouse(msg, env);
  }
  if (msg.kind === 'key') {
    return planKey(msg);
  }
  throw new InputRefusedError(`unknown input kind "${msg.kind}"`, 'input_kind');
}

// --- Execution ---------------------------------------------------------------

export class InputInjector {
  /**
   * Prefer `InputInjector.create()` — it loads user32 + koffi on demand so
   * this module stays importable (and its pure planners testable) anywhere.
   */
  constructor(win, { logger = null, monitor = null } = {}) {
    this.win = win;
    this.logger = logger;
    this.monitor = monitor;
    this.stats = { applied: 0, refused: 0, failed: 0, events: 0 };
  }

  static isSupported() {
    return process.platform === 'win32';
  }

  static async create(options = {}) {
    if (!InputInjector.isSupported()) {
      throw new PlatformUnsupportedError();
    }
    const koffi = (await import('koffi')).default;
    return new InputInjector(loadUser32(koffi), options);
  }

  get screen() {
    return this.win.metrics();
  }

  setMonitor(rect) {
    this.monitor = rect;
  }

  env() {
    return { screen: this.screen, monitor: this.monitor };
  }

  /**
   * Inject one already-validated input message.
   * @throws {InputRefusedError|PlatformUnsupportedError|Error}
   * @returns {{applied:number, events:object[]}}
   */
  apply(msg) {
    let events;
    try {
      events = plan(msg, this.env());
    } catch (err) {
      this.stats.refused += 1;
      throw err;
    }
    try {
      this.win.send(events);
    } catch (err) {
      this.stats.failed += 1;
      this.logger?.error('inject_failed', { err: String(err?.message ?? err) });
      throw err;
    }
    this.stats.applied += 1;
    this.stats.events += events.length;
    return { applied: events.length, events };
  }
}

function loadUser32(koffi) {
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'uint32',
    dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16',
  });
  const INPUTUNION = koffi.union('INPUTUNION', {
    mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT,
  });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION });

  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
  const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int']);
  const inputSize = koffi.sizeof(INPUT);

  const toInput = (event) => {
    if (event.kind === 'mouse') {
      return {
        type: 0,
        u: {
          mi: {
            dx: event.dx, dy: event.dy, mouseData: event.mouseData,
            dwFlags: event.flags, time: 0, dwExtraInfo: 0,
          },
        },
      };
    }
    const dwFlags = (event.up ? KEYEVENTF.KEYUP : 0)
      | (event.extended ? KEYEVENTF.EXTENDEDKEY : 0);
    return {
      type: 1,
      u: { ki: { wVk: event.vk, wScan: 0, dwFlags, time: 0, dwExtraInfo: 0 } },
    };
  };

  return {
    inputSize,
    metrics: () => ({
      x: GetSystemMetrics(76),
      y: GetSystemMetrics(77),
      width: GetSystemMetrics(78),
      height: GetSystemMetrics(79),
    }),
    send(events) {
      const inputs = events.map(toInput);
      const injected = SendInput(inputs.length, inputs, inputSize);
      if (injected !== inputs.length) {
        throw new Error(`SendInput injected ${injected}/${inputs.length} events`);
      }
    },
  };
}

/** @returns {Promise<InputInjector>} @throws {PlatformUnsupportedError} */
export async function createInputInjector(options = {}) {
  return InputInjector.create(options);
}
