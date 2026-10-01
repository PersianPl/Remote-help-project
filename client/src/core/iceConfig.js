/**
 * ICE configuration — config-driven by design (stage 4).
 *
 * Rules:
 * - Nothing is hardcoded: no STUN/TURN URLs, no credentials in this repo.
 * - Default is an EMPTY iceServers list: pure host candidates are enough
 *   for LAN/local tests and for peers with public IPs.
 * - TURN can be added later purely via config — no code change.
 * - describeIceConfig() is the ONLY thing allowed in logs/diagnostics:
 *   counts and URL schemes, never usernames/credentials.
 */

export const DEFAULT_ICE_CONFIG = Object.freeze({
  iceServers: Object.freeze([]),
  iceTransportPolicy: 'all',
});

const URL_SCHEME = /^(stun|stuns|turn|turns):[^\s]+$/i;

export class IceConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IceConfigError';
  }
}

/** Validates a raw ICE config object; returns a frozen, normalized copy. */
export function loadIceConfig(raw = null) {
  const input = raw ?? DEFAULT_ICE_CONFIG;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new IceConfigError('ice config must be an object');
  }

  const policy = input.iceTransportPolicy ?? 'all';
  if (!['all', 'relay'].includes(policy)) {
    throw new IceConfigError('iceTransportPolicy must be "all" or "relay"');
  }

  const servers = input.iceServers ?? [];
  if (!Array.isArray(servers)) {
    throw new IceConfigError('iceServers must be an array');
  }

  const normalized = servers.map((server, index) => {
    if (typeof server !== 'object' || server === null) {
      throw new IceConfigError(`iceServers[${index}] must be an object`);
    }
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (urls.length === 0 || urls.some((u) => typeof u !== 'string' || !URL_SCHEME.test(u))) {
      throw new IceConfigError(`iceServers[${index}].urls invalid`);
    }

    const needsCredentials = urls.some((u) => u.toLowerCase().startsWith('turn'));
    const hasUser = typeof server.username === 'string' && server.username.length > 0;
    const hasPass = typeof server.credential === 'string' && server.credential.length > 0;
    if (needsCredentials && (!hasUser || !hasPass)) {
      throw new IceConfigError(`iceServers[${index}] is TURN but lacks username/credential`);
    }
    if (!needsCredentials && (server.username !== undefined || server.credential !== undefined)) {
      throw new IceConfigError(`iceServers[${index}] is STUN but carries credentials`);
    }

    const out = { urls: Object.freeze([...urls]) };
    if (needsCredentials) {
      out.username = server.username;
      out.credential = server.credential;
    }
    return Object.freeze(out);
  });

  return Object.freeze({
    iceServers: Object.freeze(normalized),
    iceTransportPolicy: policy,
  });
}

/** Safe summary for diagnostics/logs — schemes + counts only, never secrets. */
export function describeIceConfig(config) {
  const summary = { stun: 0, turn: 0, policy: config.iceTransportPolicy };
  for (const server of config.iceServers) {
    for (const url of server.urls) {
      const scheme = url.split(':')[0].toLowerCase();
      if (scheme.startsWith('turn')) {
        summary.turn += 1;
      } else {
        summary.stun += 1;
      }
    }
  }
  return summary;
}
