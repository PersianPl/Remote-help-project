/**
 * CLI smoke test: real PHP backend + real host_cli + real viewer_cli.
 *
 *   node tools/smoke_cli.mjs
 *
 * Verifies the operator-facing path end to end: a code is printed, a viewer
 * joins and receives actual JPEG frames on disk, then the host shuts down
 * cleanly. Nothing is injected into the OS (the host runs with --no-input).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..');
const serverDir = path.resolve(clientDir, '..', 'server');
const phpBinary = process.env.RH_PHP ?? 'php';
const port = 8700 + (process.pid % 200);
const baseUrl = `http://127.0.0.1:${port}`;

const children = [];
const logs = { server: '', host: '', viewer: '' };

function fail(message) {
  console.error(`\nSMOKE FAILED: ${message}`);
  for (const [name, text] of Object.entries(logs)) {
    if (text.trim()) {
      console.error(`--- ${name} ---\n${text.trim()}`);
    }
  }
  process.exitCode = 1;
}

function track(child, name) {
  children.push(child);
  child.stdout?.on('data', (chunk) => { logs[name] += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { logs[name] += chunk.toString(); });
  return child;
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

function cleanup(tempDir) {
  for (const child of children) {
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
    } catch { /* already gone */ }
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'rh_smoke_cli_'));
let ok = false;

try {
  const configPath = path.join(tempDir, 'config.php');
  writeFileSync(configPath, `<?php\nreturn json_decode(<<<'JSON'\n${JSON.stringify({
    db: { driver: 'sqlite', sqlite_path: path.join(tempDir, 'smoke.sqlite').replace(/\\/g, '/'), mysql: {} },
    code_ttl: 300,
    session_ttl: 600,
    // php -S is single-threaded on Windows (no fork): a long hold starves
    // every other request, so the dev/smoke config keeps holds short.
    max_hold: 1,
    poll_interval_us: 50000,
    max_payload_bytes: 262144,
    rate_limits: {
      create: { limit: 50, window: 300 },
      join_ip: { limit: 50, window: 300 },
      join_code: { limit: 20, window: 60 },
      signal: { limit: 5000, window: 60 },
    },
    allowed_origins: [],
    log_level: 'warn',
    log_file: '',
  })}\nJSON, true);\n`);

  const server = track(spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t',
    path.join(serverDir, 'public'), path.join(serverDir, 'public', 'router.php')], {
    cwd: serverDir,
    env: { ...process.env, RH_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  }), 'server');

  await waitFor(() => server.exitCode === null && logs.server.includes('Development Server'),
    15000, 'the PHP dev server');
  console.log(`backend listening on ${baseUrl}`);

  const host = track(spawn(process.execPath, ['src/host/host_cli.js',
    '--server', baseUrl, '--auto-approve', '--no-input',
    '--max-width', '640', '--quality', '50', '--fps', '4', '--log', 'warn'], {
    cwd: clientDir, stdio: ['pipe', 'pipe', 'pipe'],
  }), 'host');

  const codeMatch = await waitFor(
    () => /Session code:\s*(\d{3}-\d{3})/.exec(logs.host),
    25000, 'the host session code'
  ).catch((err) => { fail(err.message); return null; });
  if (!codeMatch) {
    throw new Error('no session code');
  }
  const code = codeMatch[1];
  console.log(`host created session ${code}`);

  const framesDir = path.join(tempDir, 'frames');
  const viewer = track(spawn(process.execPath, ['src/viewer/viewer_cli.js',
    '--server', baseUrl, '--code', code, '--frames-dir', framesDir,
    '--max-frames', '3', '--stats', '0', '--log', 'warn'], {
    cwd: clientDir, stdio: ['pipe', 'pipe', 'pipe'],
  }), 'viewer');

  const viewerExit = await waitFor(
    // NOTE: exitCode 0 is falsy — wrap it, never use the raw code as predicate.
    () => (viewer.exitCode !== null ? { code: viewer.exitCode } : null),
    90000, 'the viewer to save 3 frames and exit'
  ).catch((err) => { fail(err.message); return null; });
  if (viewerExit === null) {
    throw new Error('viewer did not exit');
  }
  if (viewerExit.code !== 0) {
    throw new Error(`viewer exited with ${viewerExit.code}`);
  }

  const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  if (files.length < 3) {
    throw new Error(`expected 3 saved frames, found ${files.length}`);
  }
  let totalBytes = 0;
  for (const file of files) {
    const bytes = readFileSync(path.join(framesDir, file));
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error(`${file} is not a JPEG`);
    }
    if (bytes.length < 500) {
      throw new Error(`${file} is suspiciously small (${bytes.length} bytes)`);
    }
    totalBytes += bytes.length;
  }
  console.log(`viewer saved ${files.length} JPEG frames (${Math.round(totalBytes / files.length)} bytes avg)`);

  host.stdin.write('q\n');
  const hostExit = await waitFor(
    () => (host.exitCode !== null ? { code: host.exitCode } : null),
    20000, 'the host to quit'
  ).catch((err) => { fail(err.message); return null; });
  if (hostExit === null || hostExit.code !== 0) {
    throw new Error(`host exited with ${hostExit?.code ?? 'nothing'}`);
  }
  console.log('host shut down cleanly');

  ok = true;
  console.log('\nSMOKE OK: backend + host_cli + viewer_cli + frames on disk');
} catch (err) {
  fail(err.message ?? String(err));
} finally {
  cleanup(tempDir);
}

process.exitCode = ok ? 0 : (process.exitCode || 1);
