import os from 'node:os';

/**
 * Network interface visibility + explicit selection (stage 12).
 *
 * Contract:
 * - the user sees and picks an interface; when one is selected the app
 *   NEVER silently fails over to another one
 * - if the selected interface disappears, we throw/report
 *   InterfaceUnavailableError instead of pretending everything is fine
 * - allowFallback=true exists only as an explicit, visible user choice
 *
 * Enforcement points:
 * 1. signaling: http localAddress pinning (http.js)
 * 2. ICE: host candidates not owned by the selected interface are
 *    dropped; srflx/relay are dropped too under strict selection because
 *    their egress path cannot be attributed to an interface from JS
 */

export class InterfaceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InterfaceUnavailableError';
    this.code = 'interface_unavailable';
  }
}

/** @returns {Array<{name:string, ipv4:string[], ipv6:string[], all:object[]}>} */
export function listInterfaces({ includeInternal = false } = {}) {
  const raw = os.networkInterfaces();
  const out = [];
  for (const [name, addresses] of Object.entries(raw)) {
    const all = (addresses ?? []).map((a) => ({
      address: a.address,
      family: a.family === 'IPv4' || a.family === 4 ? 'IPv4' : 'IPv6',
      internal: a.internal,
    }));
    if (!includeInternal && all.every((a) => a.internal)) {
      continue;
    }
    out.push({
      name,
      ipv4: all.filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address),
      ipv6: all.filter((a) => a.family === 'IPv6' && !a.internal).map((a) => a.address),
      all,
    });
  }
  return out;
}

/**
 * @returns {{name:string, allowedIps:string[], requested:string, fallback:boolean}}
 * @throws {InterfaceUnavailableError} when the interface is missing and
 *         allowFallback is false (the default — no silent failover)
 */
export function selectInterface(name, { interfaces = null, allowFallback = false } = {}) {
  const list = interfaces ?? listInterfaces();
  const found = list.find((iface) => iface.name === name);
  const usable = found && found.ipv4.length > 0;

  if (!usable) {
    if (allowFallback) {
      return { name: null, allowedIps: [], requested: name, fallback: true };
    }
    throw new InterfaceUnavailableError(
      `selected network interface "${name}" is unavailable — `
      + 'refusing to fall back silently; select another interface explicitly'
    );
  }
  return { name: found.name, allowedIps: [...found.ipv4], requested: name, fallback: false };
}

function candidateTyp(candidateString) {
  const match = / typ ([a-z]+) /.exec(candidateString);
  return match ? match[1] : 'host';
}

function candidateIp(candidateString) {
  const match = / ([0-9]{1,3}(?:\.[0-9]{1,3}){3}) /.exec(candidateString);
  return match ? match[1] : null;
}

/**
 * ICE candidate filter factory for Negotiator.
 * @param {{name:string, allowedIps:string[]}|null} selection null → pass all
 */
export function makeCandidateFilter(selection) {
  if (!selection || selection.name === null) {
    return null; // no explicit selection → normal behavior
  }
  return (init) => {
    const candidate = init?.candidate ?? '';
    if (candidateTyp(candidate) !== 'host') {
      return null; // strict: non-host candidates can't be attributed to the chosen interface
    }
    const ip = candidateIp(candidate);
    return ip && selection.allowedIps.includes(ip) ? init : null;
  };
}

/** localAddress for signaling HTTP pinning, or null when unselected. */
export function signalingLocalAddress(selection) {
  if (!selection || selection.name === null || selection.fallback) {
    return null;
  }
  return selection.allowedIps[0] ?? null;
}
