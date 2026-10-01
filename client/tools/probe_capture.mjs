/**
 * Probe: koffi → GDI BitBlt capture + EnumDisplayMonitors callback.
 * Run: node tools/probe_capture.mjs
 */
import koffi from 'koffi';

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'int32', biHeight: 'int32',
  biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
  biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32', biClrImportant: 'uint32',
});
const RGBQUAD = koffi.struct('RGBQUAD', {
  rgbBlue: 'uint8', rgbGreen: 'uint8', rgbRed: 'uint8', rgbReserved: 'uint8',
});
const BITMAPINFO = koffi.struct('BITMAPINFO', {
  bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array(RGBQUAD, 1),
});
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });

console.log('sizeof(BITMAPINFO)', koffi.sizeof(BITMAPINFO));

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

const GetDC = user32.func('GetDC', 'void *', ['void *']);
const ReleaseDC = user32.func('ReleaseDC', 'int', ['void *', 'void *']);
const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int']);
const EnumDisplayMonitors = user32.func('EnumDisplayMonitors', 'int', ['void *', koffi.pointer(RECT), 'void *', 'intptr_t']);
const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', 'void *', ['void *']);
const CreateDIBSection = gdi32.func('CreateDIBSection', 'void *', ['void *', koffi.pointer(BITMAPINFO), 'uint32', 'void *', 'void *', 'uint32']);
const SelectObject = gdi32.func('SelectObject', 'void *', ['void *', 'void *']);
const BitBlt = gdi32.func('BitBlt', 'int', ['void *', 'int', 'int', 'int', 'int', 'void *', 'int', 'int', 'uint32']);
const DeleteObject = gdi32.func('DeleteObject', 'int', ['void *']);
const DeleteDC = gdi32.func('DeleteDC', 'int', ['void *']);

const width = GetSystemMetrics(78);   // SM_CXVIRTUALSCREEN
const height = GetSystemMetrics(79);  // SM_CYVIRTUALSCREEN
const originX = GetSystemMetrics(76);
const originY = GetSystemMetrics(77);
console.log('virtual desktop', { originX, originY, width, height });

const srcDc = GetDC(null);
const memDc = CreateCompatibleDC(srcDc);
const bmi = { bmiHeader: {
  biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height,
  biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: width * height * 4,
  biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
} };
const bmiBuf = koffi.as(bmi, koffi.pointer(BITMAPINFO));
const ppv = koffi.alloc('void *', 1);
const SRCCOPY = 0x00CC0020;
const CAPTUREBLT = 0x40000000;

const t0 = process.hrtime.bigint();
const hbmp = CreateDIBSection(memDc, bmiBuf, 0, ppv, null, 0);
if (!hbmp) throw new Error('CreateDIBSection failed');
const old = SelectObject(memDc, hbmp);
const ok = BitBlt(memDc, 0, 0, width, height, srcDc, originX, originY, SRCCOPY | CAPTUREBLT);
const t1 = process.hrtime.bigint();
const bits = koffi.decode(ppv, 'void *');
const pixels = koffi.decode(bits, koffi.array('uint8', width * height * 4));
console.log('BitBlt ok =', ok, 'capture ms =', Number(t1 - t0) / 1e6, 'pixel bytes =', pixels.length);
console.log('first pixel BGRA =', pixels[0], pixels[1], pixels[2], pixels[3]);

SelectObject(memDc, old);
DeleteObject(hbmp);
DeleteDC(memDc);
ReleaseDC(null, srcDc);

// Monitor enumeration with a koffi callback
const monitors = [];
const MONITORENUMPROC = koffi.proto('int MONITORENUMPROC(void *hmon, void *hdc, RECT *rect, intptr_t data)');
const cb = koffi.register((hmon, hdc, rectPtr, data) => {
  const rect = koffi.decode(rectPtr, RECT);
  monitors.push({ ...rect });
  return 1;
}, koffi.pointer(MONITORENUMPROC));
const count = EnumDisplayMonitors(null, null, cb, 0);
koffi.unregister(cb);
console.log('monitors =', count, JSON.stringify(monitors));
