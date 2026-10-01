/**
 * Throwaway probe: verifies the koffi → user32 surface the injector needs.
 * Run: node tools/probe_win32.mjs
 */
import koffi from 'koffi';

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
const INPUTUNION = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION });

const user32 = koffi.load('user32.dll');

const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int']);
const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int']);
const VkKeyScanW = user32.func('VkKeyScanW', 'int16', ['uint16']);

console.log('sizeof(INPUT) =', koffi.sizeof(INPUT));
console.log('sizeof(union) =', koffi.sizeof(INPUTUNION));
console.log('primary screen =', GetSystemMetrics(0), 'x', GetSystemMetrics(1));
console.log('virtual desktop =', GetSystemMetrics(78), 'x', GetSystemMetrics(79),
  'origin', GetSystemMetrics(76), GetSystemMetrics(77));
console.log('VkKeyScanW("a") =', VkKeyScanW('a'.charCodeAt(0)));
console.log('VkKeyScanW("A") =', VkKeyScanW('A'.charCodeAt(0)));
console.log('VkKeyScanW("=") =', VkKeyScanW('='.charCodeAt(0)));
console.log('SendInput loaded:', typeof SendInput === 'function');

// Zero-injection sanity: an INPUT with no flags sends nothing meaningful.
const input = { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } } };
console.log('INPUT a second time (no SendInput call) —', JSON.stringify(input).length, 'bytes encoded');
