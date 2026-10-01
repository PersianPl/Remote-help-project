/**
 * Probe: does POST /close complete while a long-poll is active?
 * Run: node tools/probe_close.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { SessionClient } from '../src/core/SessionClient.js';
import { LongPollingTransport } from '../src/core/signaling/LongPollingTransport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..', 'server');
const port = 8900 + (process.pid % 50);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = mkdtempSync(path.join(tmpdir(), 'rh_probe_close_'));

const configPath = path.join(tempDir, 'config.php');
writeFileSync(configPath, `<?php\nreturn json_decode(<<<'JSON'\n${JSON.stringify({
  db: { driver: 'sqlite', sqlite_path: path.join(tempDir, 'p.sqlite').replace(/\\/g, '/'), mysql: {} },
  code_ttl: 300, session_ttl: 600, max_hold: 1, poll_interval_us: 50000,
  max_payload_bytes: 262144,
  rate_limits: { create: { limit: 50, window: 300 }, join_ip: { limit: 50, window: 300 }, join_code: { limit: 20, window: 60 }, signal: { limit: 5000, window: 60 } },
  allowed_origins: [], log_level: 'warn', log_file: '',
})}\nJSON, true);\n`);

const server = spawn((process.env.RH_PHP ?? 'php'), ['-S', `127.0.0.1:${port}`, '-t',
  path.join(serverDir, 'public'), path.join(serverDir, 'public', 'router.php')],
{ cwd: serverDir, env: { ...process.env, RH_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

try {
  // wait for the server
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(150);
  }

  const client = new SessionClient({ baseUrl });
  const session = await client.create();
  console.log('created', session.sessionId, session.code);

  const transport = new LongPollingTransport({ baseUrl, token: session.token, holdSec: 1 });
  transport.on('ended', (reason) => console.log('transport ended:', reason));
  transport.start();
  await sleep(1500); // let at least one hold start
  console.log('poll loop running');

  const t0 = Date.now();
  const result = await Promise.race([
    client.close(session.sessionId, session.token).then(() => 'closed'),
    sleep(20000).then(() => 'TIMEOUT'),
  ]);
  console.log(`POST /close → ${result} after ${Date.now() - t0}ms`);

  transport.stop();
} catch (err) {
  console.log('probe error:', err?.message ?? err);
} finally {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}
