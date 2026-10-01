import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HostSession } from '../src/host/HostSession.js';
import { ViewerSession } from '../src/viewer/ViewerSession.js';
import { loadIceConfig } from '../src/core/iceConfig.js';
import { encodeBgraToJpeg, ScreenCapture } from '../src/host/capture/ScreenCapture.js';

/**
 * End-to-end loopback: real PHP backend (php -S + SQLite) + two real werift
 * peers in one process + real Long-Polling signaling + real datachannels.
 * Environment gate: needs the `php` CLI on PATH (or RH_PHP=<path>).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..', 'server');
const phpBinary = process.env.RH_PHP ?? 'php';
const port = 8400 + (process.pid % 400);
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess = null;
let tempDir = null;
let serverLog = '';

const iceConfig = loadIceConfig();

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Waits for one emitter event; rejects on timeout so a hang is a failure. */
function once(emitter, event, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`));
    }, timeoutMs);
    const off = emitter.on(event, (...args) => {
      clearTimeout(timer);
      off();
      resolve(args);
    });
  });
}

/** Polls a predicate until it returns a truthy value. */
async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/api/v1/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.ok === true) {
            return body;
          }
        }
      } catch {
        /* server not up yet */
      }
      await sleep(200);
    }
    throw new Error(`backend did not become healthy at ${baseUrl}\n${serverLog}`);
  })();
}

before(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'rh_client_it_'));
  const configPath = path.join(tempDir, 'config.php');
  const config = {
    db: { driver: 'sqlite', sqlite_path: path.join(tempDir, 'it.sqlite').replace(/\\/g, '/'), mysql: {} },
    code_ttl: 120,
    session_ttl: 600,
    max_hold: 5,
    poll_interval_us: 100000,
    max_payload_bytes: 262144,
    rate_limits: {
      create: { limit: 200, window: 300 },
      join_ip: { limit: 200, window: 300 },
      join_code: { limit: 50, window: 60 },
      signal: { limit: 5000, window: 60 },
    },
    allowed_origins: [],
    log_level: 'warn',
    log_file: '',
  };
  writeFileSync(
    configPath,
    `<?php\nreturn json_decode(<<<'JSON'\n${JSON.stringify(config)}\nJSON, true);\n`
  );

  serverProcess = spawn(
    phpBinary,
    ['-d', 'display_errors=1', '-S', `127.0.0.1:${port}`, '-t',
      path.join(serverDir, 'public'), path.join(serverDir, 'public', 'router.php')],
    {
      cwd: serverDir,
      env: { ...process.env, RH_CONFIG: configPath, PHP_CLI_SERVER_WORKERS: '4' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  serverProcess.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  serverProcess.on('error', (err) => { serverLog += `\nspawn error: ${err.message}`; });

  await waitForHealth();
});

after(() => {
  if (serverProcess) {
    serverProcess.stdout?.destroy();
    serverProcess.stderr?.destroy();
    serverProcess.kill();
    serverProcess.unref?.();
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

test('host and viewer connect, share a frame and gate input end-to-end', { timeout: 120000 }, async (t) => {
  if (!serverProcess || serverLog.includes('spawn error')) {
    t.skip(`php CLI unavailable: ${serverLog.trim().slice(0, 200)}`);
    return;
  }

  const host = new HostSession({ baseUrl, iceConfig, holdSec: 2, negotiationTimeoutMs: 30000 });
  const viewer = new ViewerSession({ baseUrl, iceConfig, holdSec: 2, negotiationTimeoutMs: 30000 });
  const hostErrors = [];
  const viewerErrors = [];
  host.on('error', (e) => hostErrors.push(e));
  viewer.on('error', (e) => viewerErrors.push(e));

  try {
    // 1. host creates a session and gets a human code
    const createdEvent = once(host, 'created', 15000);
    await host.create();
    await createdEvent;
    assert.match(host.session.code, /^[0-9]{3}-[0-9]{3}$/, `code format was ${host.session.code}`);
    assert.equal(host.sessionState, 'waiting');

    // 2. viewer joins with the one-time code → host is told
    const joined = once(host, 'viewer_joined', 20000);
    await viewer.join(host.session.code);
    await joined;
    assert.equal(viewer.session.role, 'viewer');

    // 3. host approves → offer/answer/ICE over Long-Polling → both ready
    const hostReady = once(host, 'ready', 60000);
    const viewerReady = once(viewer, 'ready', 60000);
    const viewerApproved = once(viewer, 'approved', 30000);
    await host.approve();
    await viewerApproved;
    const [{ channels }] = await hostReady;
    await viewerReady;

    assert.equal(host.peerState, 'connected');
    assert.equal(viewer.peerState, 'connected');
    assert.equal(typeof channels.frames.send, 'function', 'host frames channel is open');
    assert.equal(typeof channels.input.send, 'function', 'host input channel is open');
    assert.ok(host.inputPolicy, 'input policy exists but stays disabled by default');
    assert.equal(host.inputEnabled, false, 'remote input is opt-in per session');

    // 4. a real frame travels host → viewer byte-for-byte
    const frame = ScreenCapture.isSupported()
      ? await (async () => {
        const capture = await ScreenCapture.create({ maxWidth: 320, quality: 45 });
        const grabbed = await capture.grab();
        capture.close();
        return grabbed;
      })()
      : await (async () => {
        const width = 64;
        const height = 48;
        const bgra = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i += 1) {
          bgra[i * 4] = i % 256;
          bgra[i * 4 + 1] = (i * 2) % 256;
          bgra[i * 4 + 2] = (i * 3) % 256;
          bgra[i * 4 + 3] = 255;
        }
        const jpeg = await encodeBgraToJpeg(bgra, width, height, { quality: 45 });
        return { width: jpeg.width, height: jpeg.height, data: jpeg.data, tsMs: Date.now() };
      })();

    const received = once(viewer, 'frame', 30000);
    assert.equal(host.sendFrame(frame), true, 'frame was accepted by the sender');
    const [delivered] = await received;
    assert.equal(delivered.width, frame.width);
    assert.equal(delivered.height, frame.height);
    assert.ok(Buffer.from(delivered.data).equals(Buffer.from(frame.data)), 'frame bytes identical end-to-end');
    assert.equal(viewer.receiver.stats.received, 1);
    assert.ok(viewer.receiver.stats.kbps > 0);

    // 5. remote input is refused until the host explicitly allows it
    const refused = once(host, 'input_rejected', 15000);
    viewer.sendInput({ t: 'input', kind: 'mouse', action: 'move', x: 10, y: 10 });
    const [refusal] = await refused;
    assert.equal(refusal.reason, 'input_disabled');

    // 6. after explicit approval the same message arrives as validated data
    host.allowRemoteInput();
    assert.equal(host.inputEnabled, true);
    const accepted = once(host, 'input', 15000);
    viewer.sendInput({ t: 'input', kind: 'mouse', action: 'move', x: 120, y: 80 });
    const [message] = await accepted;
    assert.deepEqual(message, { kind: 'mouse', action: 'move', x: 120, y: 80 });

    // 7. the permanent key blocklist survives the whole pipeline
    const blocked = once(host, 'input_rejected', 15000);
    viewer.sendInput({ t: 'input', kind: 'key', action: 'down', key: 'lwin' });
    const [blockedInfo] = await blocked;
    assert.equal(blockedInfo.reason, 'input_blocked_key');

    // 8. closing the viewer ends the host session via a system message
    const hostEnded = once(host, 'ended', 30000);
    await viewer.close();
    const [endedReason] = await hostEnded;
    assert.ok(typeof endedReason === 'string' && endedReason.length > 0, `reason was ${endedReason}`);

    // 9. diagnostics stay token-free
    const hostDiag = JSON.stringify(host.diagnostics());
    const viewerDiag = JSON.stringify(viewer.diagnostics());
    assert.ok(!hostDiag.includes(host.session.token), 'host diagnostics never expose the token');
    assert.ok(!viewerDiag.includes(viewer.session.token), 'viewer diagnostics never expose the token');
    assert.equal(host.diagnostics().role, 'host');
    assert.equal(viewer.diagnostics().role, 'viewer');
    assert.equal(host.diagnostics().inputPolicyStats.accepted >= 1, true);

    assert.deepEqual(hostErrors, [], 'no host-side errors during the run');
    assert.deepEqual(viewerErrors, [], 'no viewer-side errors during the run');
    assert.ok(host.ignoredSelfMessages >= 1, 'the host ignored the echo of its own offer');
    assert.ok(viewer.ignoredSelfMessages >= 1, 'the viewer ignored the echo of its own answer');
  } finally {
    await host.close({ reason: 'test_teardown' }).catch(() => {});
    await viewer.close({ reason: 'test_teardown' }).catch(() => {});
  }
});

test('auto-approve wins the join_requested/state race and approve() is idempotent', { timeout: 120000 }, async (t) => {
  if (!serverProcess || serverLog.includes('spawn error')) {
    t.skip(`php CLI unavailable: ${serverLog.trim().slice(0, 200)}`);
    return;
  }

  // The join_requested message is emitted BEFORE the state event for the same
  // batch, so auto-approval must not depend on the local state mirror.
  const host = new HostSession({
    baseUrl, iceConfig, holdSec: 2, negotiationTimeoutMs: 30000, autoApprove: true,
  });
  const viewer = new ViewerSession({ baseUrl, iceConfig, holdSec: 2, negotiationTimeoutMs: 30000 });
  const hostErrors = [];
  host.on('error', (e) => hostErrors.push(e));

  try {
    await host.create();
    const hostReady = once(host, 'ready', 60000);
    const viewerReady = once(viewer, 'ready', 60000);
    await viewer.join(host.session.code); // no explicit approve() call anywhere
    await hostReady;
    await viewerReady;

    assert.equal(host.peerState, 'connected');
    assert.equal(viewer.peerState, 'connected');
    assert.deepEqual(hostErrors, [], 'auto-approval produced no errors');

    // Idempotency: a redelivered join_requested (or a second operator click)
    // must not blow up on the server state machine.
    await host.approve();
    assert.equal(host.peerState, 'connected', 'still connected after a duplicate approve');

    // The host only mirrors the authoritative server state from the queue.
    await waitUntil(() => host.sessionState === 'connected', 20000, 'host sessionState=connected');
    assert.equal(host.diagnostics().sessionState, 'connected');
  } finally {
    await host.close({ reason: 'test_teardown' }).catch(() => {});
    await viewer.close({ reason: 'test_teardown' }).catch(() => {});
  }

  // Teardown must really release sockets/channels. Regression: _cleanupLocal()
  // used to return early because close() had already set the _closed flag,
  // which leaked the peer connection and kept the process alive.
  assert.equal(host.transport.running, false, 'host signaling transport stopped');
  assert.equal(host.frameSender, null, 'host frame sender released');
  assert.equal(host.peer.state === 'closed', true, `host peer was ${host.peer.state}`);
  assert.equal(viewer.receiver, null, 'viewer frame receiver detached');
  assert.equal(viewer.inputChannel, null, 'viewer input channel released');
  assert.equal(viewer.transport.running, false, 'viewer signaling transport stopped');
});
