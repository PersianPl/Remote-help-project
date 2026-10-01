import { createRequire } from 'node:module';

/**
 * Windows desktop capture (stage 4) — koffi → GDI BitBlt → JPEG.
 *
 * Why GDI and not Desktop Duplication/DXGI: DXGI needs full COM interop that
 * koffi cannot express safely, while BitBlt from the desktop DC captures the
 * DWM-composited image (including layered windows when CAPTUREBLT is set) and
 * needs no native build step on shared-hosting-friendly Node installs.
 * Verified on this machine: 1920x1080 grab ≈ 38 ms.
 *
 * The capture half is deliberately pure-ish: listMonitors()/grabRaw() only
 * read the screen; JPEG encoding + downscaling are separate, testable
 * functions. Frames leave the process through WebRTC only.
 */

export class CaptureUnsupportedError extends Error {
  constructor(message = 'screen capture is only supported on Windows (GDI via user32/gdi32)') {
    super(message);
    this.name = 'CaptureUnsupportedError';
    this.code = 'capture_unsupported';
  }
}

export class CaptureError extends Error {
  constructor(message, code = 'capture_failed') {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

let binding = null;
let types = null;
const require = createRequire(import.meta.url);

/** koffi is CJS; a synchronous require keeps listMonitors()/grabRaw() plain. */
function koffiModule() {
  return require('koffi');
}

/**
 * Struct/proto declarations are process-global in koffi, so they are
 * declared exactly once (names are prefixed with RH_ to avoid clashing with
 * any other koffi user in the same process).
 */
function declareTypes() {
  if (types) {
    return types;
  }
  const koffi = koffiModule();
  const BITMAPINFOHEADER = koffi.struct('RH_BITMAPINFOHEADER', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32',
    biPlanes: 'uint16', biBitCount: 'uint16', biCompression: 'uint32',
    biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });
  const RGBQUAD = koffi.struct('RH_RGBQUAD', {
    rgbBlue: 'uint8', rgbGreen: 'uint8', rgbRed: 'uint8', rgbReserved: 'uint8',
  });
  const BITMAPINFO = koffi.struct('RH_BITMAPINFO', {
    bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array(RGBQUAD, 1),
  });
  const RECT = koffi.struct('RH_RECT', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
  });
  const MONITORENUMPROC = koffi.proto(
    'int RH_MONITORENUMPROC(void *hmon, void *hdc, RH_RECT *rect, intptr_t data)'
  );

  types = {
    koffi, RECT, BITMAPINFO, MONITORENUMPROC,
    headerSize: koffi.sizeof(BITMAPINFOHEADER),
  };
  return types;
}

/** Lazily loads user32/gdi32 once per process. */
function loadGdi() {
  if (binding) {
    return binding;
  }
  const t = declareTypes();
  const { koffi, RECT, BITMAPINFO } = t;
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');

  binding = {
    ...t,
    user32,
    gdi32,
    GetDC: user32.func('GetDC', 'void *', ['void *']),
    ReleaseDC: user32.func('ReleaseDC', 'int', ['void *', 'void *']),
    GetSystemMetrics: user32.func('GetSystemMetrics', 'int', ['int']),
    EnumDisplayMonitors: user32.func(
      'EnumDisplayMonitors',
      'int',
      ['void *', koffi.pointer(RECT), 'void *', 'intptr_t']
    ),
    CreateCompatibleDC: gdi32.func('CreateCompatibleDC', 'void *', ['void *']),
    CreateDIBSection: gdi32.func(
      'CreateDIBSection',
      'void *',
      ['void *', koffi.pointer(BITMAPINFO), 'uint32', 'void *', 'void *', 'uint32']
    ),
    SelectObject: gdi32.func('SelectObject', 'void *', ['void *', 'void *']),
    BitBlt: gdi32.func(
      'BitBlt',
      'int',
      ['void *', 'int', 'int', 'int', 'int', 'void *', 'int', 'int', 'uint32']
    ),
    DeleteObject: gdi32.func('DeleteObject', 'int', ['void *']),
    DeleteDC: gdi32.func('DeleteDC', 'int', ['void *']),
  };
  return binding;
}

/** Lazily-initialized Win32 binding. */
function win32() {
  return binding ?? loadGdi();
}

/** Virtual desktop rect (all monitors). */
export function virtualDesktop(win = win32()) {
  return {
    x: win.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: win.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: win.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: win.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

/**
 * Enumerates monitors via EnumDisplayMonitors (koffi callback).
 * The monitor containing (0,0) is the primary one — that is where users
 * expect "my screen" to be; a fully custom layout is reported as-is.
 * @returns {Array<{index:number, x:number, y:number, width:number, height:number, primary:boolean}>}
 */
export function listMonitors(win = win32()) {
  const found = [];
  const callback = win.koffi.register((hmon, hdc, rectPtr) => {
    const rect = win.koffi.decode(rectPtr, win.RECT);
    found.push({
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
    return 1;
  }, win.koffi.pointer(win.MONITORENUMPROC));

  try {
    win.EnumDisplayMonitors(null, null, callback, 0);
  } finally {
    win.koffi.unregister(callback);
  }

  const withIndex = found.map((m, index) => ({
    ...m,
    index,
    primary: m.x <= 0 && m.y <= 0 && 0 < m.x + m.width && 0 < m.y + m.height,
  }));
  if (withIndex.length > 0 && !withIndex.some((m) => m.primary)) {
    withIndex[0].primary = true;
  }
  return withIndex;
}

/** @returns {{index:number,x:number,y:number,width:number,height:number,primary:boolean}|null} */
export function findMonitor({ index = null, x = null, y = null, useVirtualDesktop = false } = {}, win = win32()) {
  if (useVirtualDesktop) {
    const desktop = virtualDesktop(win);
    return { index: -1, ...desktop, primary: false };
  }
  if (Number.isInteger(index) && index >= 0) {
    return listMonitors(win).find((m) => m.index === index) ?? null;
  }
  if (Number.isInteger(x) && Number.isInteger(y)) {
    return listMonitors(win).find(
      (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height
    ) ?? null;
  }
  return listMonitors(win).find((m) => m.primary) ?? null;
}

// --- Pixel pipeline (pure + unit-testable) -----------------------------------

/** GDI DIB is BGRA with a meaningless alpha byte; JPEG wants RGBA. */
export function bgraToRgba(bgra, width, height, out = new Uint8Array(width * height * 4)) {
  const pixels = width * height;
  for (let i = 0, j = 0; i < pixels; i += 1, j += 4) {
    out[j] = bgra[j + 2];
    out[j + 1] = bgra[j + 1];
    out[j + 2] = bgra[j];
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Integer box-filter downscale in BGRA space. Keeping the factor integral
 * avoids the aliasing a naive nearest-neighbour would add on text.
 * @returns {{data:Uint8Array, width:number, height:number, scaled:boolean, ratio:number}}
 */
export function downscaleBgra(bgra, width, height, targetWidth) {
  if (!Number.isFinite(targetWidth) || targetWidth >= width || targetWidth <= 0) {
    return { data: bgra, width, height, scaled: false, ratio: 1 };
  }
  const ratio = Math.max(2, Math.round(width / targetWidth));
  const outWidth = Math.max(1, Math.floor(width / ratio));
  const outHeight = Math.max(1, Math.floor(height / ratio));
  const out = new Uint8Array(outWidth * outHeight * 4);
  const samples = ratio * ratio;

  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      let b = 0;
      let g = 0;
      let r = 0;
      for (let sy = 0; sy < ratio; sy += 1) {
        let src = ((y * ratio + sy) * width + x * ratio) * 4;
        for (let sx = 0; sx < ratio; sx += 1) {
          b += bgra[src];
          g += bgra[src + 1];
          r += bgra[src + 2];
          src += 4;
        }
      }
      const dst = (y * outWidth + x) * 4;
      out[dst] = b / samples;
      out[dst + 1] = g / samples;
      out[dst + 2] = r / samples;
      out[dst + 3] = 255;
    }
  }
  return { data: out, width: outWidth, height: outHeight, scaled: true, ratio };
}

let jpegModule = null;

async function loadJpegJs() {
  if (!jpegModule) {
    const mod = await import('jpeg-js');
    jpegModule = mod.default ?? mod;
  }
  return jpegModule;
}

/** @returns {Promise<{data:Uint8Array,width:number,height:number,quality:number,encodeMs:number}>} */
export async function encodeJpeg(rgba, width, height, quality = 60) {
  const jpeg = await loadJpegJs();
  const started = Date.now();
  const input = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const encoded = jpeg.encode({ data: input, width, height }, quality);
  return {
    data: encoded.data,
    width: encoded.width ?? width,
    height: encoded.height ?? height,
    quality,
    encodeMs: Date.now() - started,
  };
}

/** Full BGRA → (downscale) → RGBA → JPEG pipeline used by grab(). */
export async function encodeBgraToJpeg(bgra, width, height, { quality = 60, maxWidth = 0 } = {}) {
  const scaled = maxWidth ? downscaleBgra(bgra, width, height, maxWidth) : { data: bgra, width, height, scaled: false, ratio: 1 };
  const rgba = bgraToRgba(scaled.data, scaled.width, scaled.height);
  const jpeg = await encodeJpeg(rgba, scaled.width, scaled.height, quality);
  return { ...jpeg, scaled: scaled.scaled, ratio: scaled.ratio };
}

// --- ScreenCapture -----------------------------------------------------------

/**
 * GDI capture session bound to one monitor (or the whole virtual desktop).
 * One DIB section is allocated and reused for the lifetime of the instance
 * (no per-frame allocation churn, nothing leaks on close()).
 */
export class ScreenCapture {
  constructor(win, monitor, { maxWidth = 1280, quality = 60, logger = null } = {}) {
    this.win = win;
    this.bounds = {
      x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
    };
    this.maxWidth = maxWidth;
    this.quality = quality;
    this.logger = logger;
    this.stats = { frames: 0, bytes: 0, lastCaptureMs: 0, lastEncodeMs: 0, failures: 0 };
    this._closed = false;
    this._bitsPtr = null;

    const { koffi } = win;
    this._srcDc = win.GetDC(null);
    if (!this._srcDc) {
      throw new CaptureError('GetDC(NULL) failed', 'capture_dc');
    }
    this._memDc = win.CreateCompatibleDC(this._srcDc);
    if (!this._memDc) {
      win.ReleaseDC(null, this._srcDc);
      throw new CaptureError('CreateCompatibleDC failed', 'capture_dc');
    }

    const info = {
      bmiHeader: {
        biSize: win.headerSize,
        biWidth: this.bounds.width,
        biHeight: -this.bounds.height, // negative → top-down rows
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        biSizeImage: this.bounds.width * this.bounds.height * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      },
    };
    this._info = koffi.as(info, koffi.pointer(win.BITMAPINFO));
    this._ppv = koffi.alloc('void *', 1);
    this._hbmp = win.CreateDIBSection(this._memDc, this._info, 0, this._ppv, null, 0);
    if (!this._hbmp) {
      win.DeleteDC(this._memDc);
      win.ReleaseDC(null, this._srcDc);
      throw new CaptureError('CreateDIBSection failed', 'capture_dib');
    }
    this._oldBitmap = win.SelectObject(this._memDc, this._hbmp);
  }

  static isSupported() {
    return process.platform === 'win32';
  }

  static async create({ monitor = null, useVirtualDesktop = false, ...options } = {}) {
    if (!ScreenCapture.isSupported()) {
      throw new CaptureUnsupportedError();
    }
    const win = win32();
    const target = monitor ?? findMonitor({ useVirtualDesktop }, win);
    if (!target) {
      throw new CaptureError('no monitor available to capture', 'capture_no_monitor');
    }
    return new ScreenCapture(win, target, options);
  }

  get size() {
    return { width: this.bounds.width, height: this.bounds.height };
  }

  /** @returns {{width:number,height:number,bgra:Uint8Array,tsMs:number,captureMs:number}} */
  grabRaw() {
    if (this._closed) {
      throw new CaptureError('capture session is closed', 'capture_closed');
    }
    const { width, height } = this.bounds;
    const started = Date.now();
    const ok = this.win.BitBlt(
      this._memDc, 0, 0, width, height,
      this._srcDc, this.bounds.x, this.bounds.y,
      SRCCOPY | CAPTUREBLT
    );
    if (!ok) {
      this.stats.failures += 1;
      throw new CaptureError('BitBlt failed (screen locked or secure desktop?)', 'capture_bitblt');
    }
    if (!this._bitsPtr) {
      this._bitsPtr = this.win.koffi.decode(this._ppv, 'void *');
    }
    const bgra = this.win.koffi.decode(
      this._bitsPtr,
      this.win.koffi.array('uint8', width * height * 4)
    );
    const captureMs = Date.now() - started;
    this.stats.lastCaptureMs = captureMs;
    return { width, height, bgra, tsMs: Date.now(), captureMs };
  }

  /** Full frame ready for the frames datachannel (JPEG). */
  async grab() {
    const raw = this.grabRaw();
    const jpeg = await encodeBgraToJpeg(raw.bgra, raw.width, raw.height, {
      quality: this.quality,
      maxWidth: this.maxWidth,
    });
    this.stats.frames += 1;
    this.stats.bytes += jpeg.data.byteLength;
    this.stats.lastEncodeMs = jpeg.encodeMs;
    return {
      width: jpeg.width,
      height: jpeg.height,
      data: jpeg.data,
      tsMs: raw.tsMs,
      captureMs: raw.captureMs,
      encodeMs: jpeg.encodeMs,
      quality: this.quality,
      scaled: jpeg.scaled,
    };
  }

  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    try {
      if (this._oldBitmap) {
        this.win.SelectObject(this._memDc, this._oldBitmap);
      }
      if (this._hbmp) {
        this.win.DeleteObject(this._hbmp);
      }
      if (this._memDc) {
        this.win.DeleteDC(this._memDc);
      }
      if (this._srcDc) {
        this.win.ReleaseDC(null, this._srcDc);
      }
    } catch (err) {
      this.logger?.warn('capture_close_failed', { err: String(err?.message ?? err) });
    }
    this._bitsPtr = null;
  }
}

/** @returns {Promise<ScreenCapture>} @throws {CaptureUnsupportedError} */
export async function createScreenCapture(options = {}) {
  return ScreenCapture.create(options);
}
