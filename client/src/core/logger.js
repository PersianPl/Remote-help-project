/**
 * Level-based logger with secret masking (stage 13).
 * Levels: debug < info < warn < error — threshold from config/logLevel.
 * Values whose key looks sensitive are redacted before formatting.
 */

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const SENSITIVE_KEY = /token|secret|password|passphrase|authorization|credential|human_code|(^|_)code$/i;

function mask(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === 'object' ? mask(item) : item));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = inner !== null && typeof inner === 'object' ? mask(inner) : inner;
      }
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor({ level = 'info', prefix = 'remote-help', sink } = {}) {
    this.threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.prefix = prefix;
    this.sink = sink ?? ((line) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  }

  child(prefix) {
    const child = new Logger({ level: Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.threshold) ?? 'info', prefix: `${this.prefix}:${prefix}`, sink: this.sink });
    return child;
  }

  log(level, event, context = {}) {
    const rank = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (rank < this.threshold) {
      return;
    }
    const parts = Object.entries(mask(context))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    this.sink(`${new Date().toISOString()} ${level.toUpperCase()} [${this.prefix}] ${event}${parts ? ' ' + parts : ''}`);
  }

  debug(event, context) { this.log('debug', event, context); }
  info(event, context) { this.log('info', event, context); }
  warn(event, context) { this.log('warn', event, context); }
  error(event, context) { this.log('error', event, context); }
}
