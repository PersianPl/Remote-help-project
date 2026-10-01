#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';

import { HostSession } from './HostSession.js';
import { FramePump } from './FramePump.js';
import { ScreenCapture, listMonitors } from './capture/ScreenCapture.js';
import { InputInjector, PlatformUnsupportedError } from './input/InputInjector.js';
import { loadIceConfig, describeIceConfig } from '../core/iceConfig.js';
import { Logger } from '../core/logger.js';
import {
  listInterfaces, selectInterface, makeCandidateFilter, signalingLocalAddress,
} from '../net/NetworkInterfaces.js';

/**
 * Remote Help — host CLI (no dependencies beyond the client core).
 *
 *   node src/host/host_cli.js --server http://127.0.0.1:8080
 *
 * Creates a session, shows the code, waits for approval, streams the selected
 * monitor as JPEG over WebRTC and — only when the operator enables it —
 * injects the viewer's validated input.
 */

const USAGE = `Remote Help host

  --server <url>        backend base URL            (default http://127.0.0.1:8080)
  --monitor <n>         monitor index to share      (default: primary)
  --virtual-desktop     share all monitors as one surface
  --max-width <px>      downscale before encoding   (default 1280)
  --quality <1-100>     JPEG quality                (default 60)
  --fps <1-30>          target frames per second    (default 8)
  --interface <name>    pin signaling + ICE to one interface (never fails over)
  --auto-approve        approve the first viewer without asking
  --allow-input         start with remote input enabled (default: off)
  --no-input            never inject remote input (viewer stays view-only)
  --log <level>         debug|info|warn|error       (default info)
  --list                list monitors and network interfaces, then exit
  --help                this text
`;

export function parseArgs(argv) {
  const options = {
    server: 'http://127.0.0.1:8080',
    monitor: null,
    virtualDesktop: false,
    maxWidth: 1280,
    quality: 60,
    fps: 8,
    interfaceName: null,
    autoApprove: false,
    allowInput: false,
    inputAllowed: true,
    logLevel: 'info',
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--server': options.server = next(); break;
      case '--monitor': options.monitor = Number.parseInt(next(), 10); break;
      case '--virtual-desktop': options.virtualDesktop = true; break;
      case '--max-width': options.maxWidth = Number.parseInt(next(), 10); break;
      case '--quality': options.quality = Number.parseInt(next(), 10); break;
      case '--fps': options.fps = Number.parseInt(next(), 10); break;
      case '--interface': options.interfaceName = next(); break;
      case '--auto-approve': options.autoApprove = true; break;
      case '--allow-input': options.allowInput = true; break;
      case '--no-input': options.inputAllowed = false; break;
      case '--log': options.logLevel = next(); break;
      case '--list': options.list = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`unknown option: ${arg}`);
        }
    }
  }
  return options;
}

function printInventory() {
  console.log('Monitors:');
  for (const monitor of listMonitors()) {
    console.log(`  [${monitor.index}]${monitor.primary ? ' (primary)' : ''} `
      + `${monitor.width}x${monitor.height} at ${monitor.x},${monitor.y}`);
  }
  console.log('Network interfaces:');
  for (const iface of listInterfaces()) {
    console.log(`  ${iface.name}: ${iface.ipv4.join(', ') || '(no IPv4)'}`);
  }
}


async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.list) {
    printInventory();
    return 0;
  }

  const logger = new Logger({ level: options.logLevel, prefix: 'host' });

  let selection = null;
  if (options.interfaceName) {
    selection = selectInterface(options.interfaceName); // throws, never falls back
    logger.info('interface_selected', { name: selection.name, ips: selection.allowedIps });
  }

  let monitor = null;
  if (options.monitor !== null) {
    monitor = listMonitors().find((m) => m.index === options.monitor) ?? null;
    if (!monitor) {
      throw new Error(`monitor ${options.monitor} does not exist (use --list)`);
    }
  }

  const capture = await ScreenCapture.create({
    monitor,
    useVirtualDesktop: options.virtualDesktop,
    maxWidth: options.maxWidth,
    quality: options.quality,
    logger,
  });

  const injector = options.inputAllowed ? await InputInjector.create({ logger }) : null;
  injector?.setMonitor(capture.bounds);

  const iceConfig = loadIceConfig(); // STUN/TURN come from config, never hardcoded
  const session = new HostSession({
    baseUrl: options.server,
    iceConfig,
    logger,
    candidateFilter: makeCandidateFilter(selection),
    localAddress: signalingLocalAddress(selection),
    autoApprove: options.autoApprove,
    inputBounds: { width: capture.bounds.width, height: capture.bounds.height },
  });
  const pump = new FramePump(session, capture, { fps: options.fps, logger });
  pump.on('drop', () => logger.debug('frame_dropped', { reason: 'congestion' }));

  console.log(`Sharing monitor ${capture.bounds.width}x${capture.bounds.height} `
    + `at ${capture.bounds.x},${capture.bounds.y} as ${options.maxWidth}px / q${options.quality} JPEG`);
  console.log(`ICE: ${JSON.stringify(describeIceConfig(iceConfig))}`);

  await session.create();
  console.log(`\n  Session code: ${session.session.code}\n  Waiting for the viewer to join...`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => { rl.question(question, resolve); });

  session.on('viewer_joined', async () => {
    if (options.autoApprove) {
      return;
    }
    const answer = (await ask('A viewer wants to connect. Approve? [y/N] ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      await session.approve().catch((err) => console.error('approve failed:', err.message));
    } else {
      await session.reject().catch((err) => console.error('reject failed:', err.message));
      console.log('Request rejected.');
    }
  });

  session.on('ready', () => {
    console.log('Connected. Streaming starts now.');
    console.log('Commands: [i] toggle remote input, [p] pause/resume streaming, [q] quit, [d] diagnostics');
    pump.start();
    if (options.allowInput && session.inputPolicy) {
      session.allowRemoteInput();
    }
  });

  session.on('input', (message) => {
    if (!session.inputEnabled || !injector) {
      return; // belt and braces: the policy is the only path to injection
    }
    try {
      injector.apply(message);
    } catch (err) {
      logger.warn('input_inject_failed', { err: String(err?.message ?? err) });
    }
  });
  session.on('input_rejected', (info) => logger.debug('input_rejected', info));
  session.on('input_state', ({ enabled }) => console.log(enabled
    ? 'Remote input ENABLED (the viewer can control this machine).'
    : 'Remote input DISABLED (view only).'));
  session.on('signaling', ({ up, reason }) => console.log(up
    ? 'Signaling reconnected.'
    : `Signaling down (${reason ?? 'network'}) — retrying in the background.`));
  session.on('ended', (reason) => console.log(`Session ended (${reason}).`));
  session.on('error', (e) => logger.warn('session_error', e));

  const shutdown = async (reason) => {
    pump.stop();
    await session.close({ reason }).catch(() => {});
    capture.close();
  };

  rl.on('line', async (line) => {
    const command = line.trim().toLowerCase();
    if (command === 'q') {
      await shutdown('host_quit');
      rl.close();
      process.exit(0);
    } else if (command === 'i') {
      if (!session.inputPolicy) {
        console.log('Input is unavailable until a viewer is connected.');
      } else if (session.inputEnabled) {
        session.disallowRemoteInput();
      } else {
        session.allowRemoteInput();
      }
    } else if (command === 'p') {
      if (pump.paused) {
        pump.resume();
        console.log('Streaming resumed.');
      } else {
        pump.pause();
        console.log('Streaming paused.');
      }
    } else if (command === 'd') {
      console.log(JSON.stringify({
        session: session.diagnostics(),
        pump: pump.diagnostics(),
        capture: capture.stats,
        injector: injector?.stats ?? null,
      }, null, 2));
    } else if (command !== '') {
      console.log('Unknown command. Use i / p / q / d.');
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await shutdown('host_interrupt');
    process.exit(0);
  });
  return null; // keeps running until the operator quits
}

main().then((code) => {
  if (code !== null) {
    // Setting exitCode (instead of process.exit) lets buffered stdout flush
    // when the CLI is used from a pipe/script.
    process.exitCode = code;
  }
}).catch((err) => {
  if (err instanceof PlatformUnsupportedError) {
    console.error(`Fatal: ${err.message}`);
  } else {
    console.error(`Fatal: ${err?.message ?? err}`);
  }
  process.exitCode = 1;
});
