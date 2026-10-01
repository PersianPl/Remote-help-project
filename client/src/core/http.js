/**
 * Isomorphic JSON HTTP.
 * - Node:   node:http/https — supports localAddress (interface binding,
 *           stage 12) and a hard deadline that does NOT trip during a
 *           silent long-poll hold (no socket-idle timeout).
 * - Browser: fetch + AbortController.
 *
 * HTTP >= 400 resolves normally with the parsed error body; only
 * transport-level failures (refused/DNS/timeout/abort) throw NetworkError.
 */

export class NetworkError extends Error {
  constructor(message, code = 'network') {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
  }
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

function combineSignals(external, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
    }
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function browserRequest({ method, url, headers, body, timeoutMs, signal }) {
  const { signal: combined, clear } = combineSignals(signal, timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, { method, headers, body: body ?? null, signal: combined });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data, elapsedMs: performance.now() - start };
  } catch (err) {
    const timedOut = combined.aborted && String(combined.reason?.message ?? '').includes('timeout');
    throw new NetworkError(
      timedOut ? `request timed out after ${timeoutMs}ms` : String(err?.message ?? err),
      timedOut ? 'timeout' : 'connection'
    );
  } finally {
    clear();
  }
}

async function nodeRequest({ method, url, headers, body, timeoutMs, localAddress, signal }) {
  const mod = url.startsWith('https:') ? await import('node:https') : await import('node:http');
  const u = new URL(url);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        ...(localAddress ? { localAddress } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = null;
          }
          finish(resolve, { status: res.statusCode ?? 0, data, elapsedMs: Date.now() - start });
        });
        res.on('error', (err) => finish(reject, new NetworkError(String(err.message), 'connection')));
      }
    );

    // Hard deadline — deliberately NOT req.setTimeout(): a long-poll hold
    // transfers no bytes and must survive until the deadline.
    const deadline = setTimeout(() => {
      req.destroy();
      finish(reject, new NetworkError(`request timed out after ${timeoutMs}ms`, 'timeout'));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        finish(reject, new NetworkError('request aborted', 'aborted'));
      } else {
        signal.addEventListener('abort', () => {
          req.destroy();
          finish(reject, new NetworkError('request aborted', 'aborted'));
        }, { once: true });
      }
    }

    req.on('error', (err) => {
      const code = err?.code === 'EADDRNOTAVAIL' ? 'address_not_available' : 'connection';
      finish(reject, new NetworkError(`${err?.code ?? ''} ${err?.message ?? err}`.trim(), code));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * @returns {Promise<{status:number, data:object|null, elapsedMs:number}>}
 */
export async function httpJson({
  method = 'GET',
  url,
  headers = {},
  body = null,
  timeoutMs = 30000,
  localAddress = null,
  signal = null,
}) {
  const finalHeaders = { Accept: 'application/json', ...headers };
  let payload = body;
  if (body !== null && typeof body !== 'string') {
    payload = JSON.stringify(body);
    finalHeaders['Content-Type'] = 'application/json';
  }
  if (payload !== null) {
    finalHeaders['Content-Length'] = String(Buffer.byteLength(payload));
  }

  const options = { method, url, headers: finalHeaders, body: payload, timeoutMs, localAddress, signal };
  return isNode ? nodeRequest(options) : browserRequest(options);
}
