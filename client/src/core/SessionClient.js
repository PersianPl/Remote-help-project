import { httpJson, NetworkError } from './http.js';

/** Machine-readable API failure (server error envelope). */
export class ApiError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function normalizeSession(data, token) {
  return {
    sessionId: data.session_id,
    code: data.code,
    state: data.state,
    role: data.role,
    token,
    createdAt: data.created_at,
    codeExpiresAt: data.code_expires_at,
    expiresAt: data.expires_at,
  };
}

/**
 * REST wrapper for the v1 backend (stage: protocol consistency).
 * All paths go through one place; errors are normalized to ApiError.
 */
export class SessionClient {
  constructor({ baseUrl, logger = null, localAddress = null, timeoutMs = 15000 }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.logger = logger;
    this.localAddress = localAddress;
    this.timeoutMs = timeoutMs;
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  async _request(method, path, { body = null, token = null } = {}) {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await httpJson({
      method,
      url: this.url(path),
      headers,
      body,
      timeoutMs: this.timeoutMs,
      localAddress: this.localAddress,
    });
    if (res.status >= 400) {
      const err = res.data?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? `HTTP ${res.status}`, err.retry_after ?? null);
    }
    return res.data ?? {};
  }

  /** @returns {Promise<object>} raw health payload (caller checks .ok) */
  async health() {
    return this._request('GET', '/api/v1/health');
  }

  /** Host creates a session. */
  async create() {
    const data = await this._request('POST', '/api/v1/sessions', { body: {} });
    return normalizeSession(data, data.host_token);
  }

  /** Viewer joins by human code (one-time). */
  async join(code) {
    const data = await this._request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(code)}/join`,
      { body: {} }
    );
    return normalizeSession(data, data.viewer_token);
  }

  approve(sessionId, token) {
    return this._request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/approve`, { body: {}, token });
  }

  reject(sessionId, token) {
    return this._request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/reject`, { body: {}, token });
  }

  close(sessionId, token) {
    return this._request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, { body: {}, token });
  }

  get(sessionId, token) {
    return this._request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}`, { token });
  }
}

export { NetworkError };
