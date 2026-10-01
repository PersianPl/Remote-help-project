#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ViewerSession } from './ViewerSession.js';
import { InputSender } from './InputSender.js';
import { loadIceConfig, describeIceConfig } from '../core/iceConfig.js';
import { Logger } from '../core/logger.js';
import { listInterfaces, selectInterface, makeCandidateFilter, signalingLocalAddress } from '../net/NetworkInterfaces.js';

/**
 * Remote Help — viewer CLI.
 *
 *   node src/viewer/viewer_cli.js --server http://127.0.0.1:8080 --code 123-456
 *
 * Rendering: this CLI writes received JPEG frames to disk (and prints live
 * stats). The production viewer renders the same frames into a canvas; the
 * transport path is identical, which is the point of this tool.
 *
 * Input: real local mouse/keyboard capture in Node would need OS-wide hooks,
 * so this CLI drives input through commands or a script file. Every message
 * still goes through InputSender (rate limit + local refusal of blocked keys)
 * and is re-validated by the host before injection.
 */

const USAGE = `Remote Help viewer

  --server <url>        backend base URL            (default http://127.0.0.1:8080)
  --code <123-456>      session code from the host  (required)
  --interface <name>    pin signaling + ICE to one interface (never fails over)
  --frames-dir <dir>    save received JPEG frames   (default: none)
  --max-frames <n>      stop after n saved frames   (default 0 = unlimited)
  --stats <sec>         print stats every n seconds (default 5, 0 = off)
  --input-script <f>    JSON-lines file of input messages to replay
  --log <level>         debug|info|warn|error       (default info)
  --help                this text

Interactive commands: m <x> <y> | c | r | b | w <delta> | k <key> | C <key> | S <key> | s | q
`;

export function parseArgs(argv) {
  const options = {
    server: 'http://127.0.0.1:8080',
    code: '',
    interfaceName: null,
    framesDir: null,
    maxFrames: 0,
    statsSec: 5,
    inputScript: null,
    logLevel: 'info',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--server': options.server = next(); break;
      case '--code': options.code = next(); break;
      case '--interface': options.interfaceName = next(); break;
      case '--frames-dir': options.framesDir = next(); break;
      case '--max-frames': options.maxFrames = Number.parseInt(next(), 10); break;
      case '--stats': options.statsSec = Number.parseInt(next(), 10); break;
      case '--input-script': options.inputScript = next(); break;
      case '--log': options.logLevel = next(); break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`unknown option: ${arg}`);
        }
    }
  }
  return options;
}


/** Saves frames as JPEG and tracks the live receive rate. */
function makeFrameSink({ framesDir, maxFrames }) {
  let saved = 0;
  if (framesDir) {
    mkdirSync(framesDir, { recursive: true });
  }
  return {
    get saved() {
      return saved;
    },
    /** @returns {boolean} true when maxFrames has been reached */
    write(frame) {
      if (!framesDir) {
        return false;
      }
      const file = path.join(framesDir, `frame-${String(frame.seq).padStart(6, '0')}.jpg`);
      writeFileSync(file, Buffer.from(frame.data));
      saved += 1;
      return maxFrames > 0 && saved >= maxFrames;
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.code) {
    process.stderr.write('error: --code is required (the host shows it)\n');
    return 2;
  }

  const logger = new Logger({ level: options.logLevel, prefix: 'viewer' });
  let selection = null;
  if (options.interfaceName) {
    selection = selectInterface(options.interfaceName); // throws, never falls back
  }

  const iceConfig = loadIceConfig();
  const session = new ViewerSession({
    baseUrl: options.server,
    iceConfig,
    logger,
    candidateFilter: makeCandidateFilter(selection),
    localAddress: signalingLocalAddress(selection),
  });
  const sender = new InputSender(session, { logger });
  const sink = makeFrameSink({ framesDir: options.framesDir, maxFrames: options.maxFrames });

  console.log(`Signaling: ${options.server}  ICE: ${JSON.stringify(describeIceConfig(iceConfig))}`);

  session.on('waiting_approval', ({ sessionId }) => {
    console.log(`Requested access (session ${sessionId}). Waiting for the host to approve...`);
  });
  session.on('approved', () => console.log('Host approved. Negotiating...'));
  session.on('rejected', () => {
    console.log('The host rejected the request.');
    process.exit(0);
  });
  session.on('connected', () => console.log('Peer connection established.'));
  session.on('ready', () => {
    console.log('Receiving.');
    console.log('Commands: m <x> <y> | c | r | b | d | w <delta> | k <key> | C <key> | S <key> | s | q');
    if (options.inputScript) {
      replayScript(options.inputScript, sender);
    }
  });
  let finished = false;
  session.on('frame', (frame) => {
    if (finished || !sink.write(frame) || options.maxFrames <= 0) {
      return;
    }
    finished = true; // a frame may arrive while the close round-trip is in flight
    console.log(`Saved ${sink.saved} frames to ${options.framesDir}; done.`);
    session.close({ reason: 'max_frames' }).then(() => process.exit(0), () => process.exit(0));
  });
  session.on('frame_invalid', (info) => logger.warn('frame_invalid', info));
  session.on('input_drop', (info) => logger.debug('input_drop', info));
  session.on('signaling', ({ up, reason }) => console.log(up
    ? 'Signaling reconnected.'
    : `Signaling down (${reason ?? 'network'}) — retrying in the background.`));
  session.on('ended', (reason) => console.log(`Session ended (${reason}).`));
  session.on('error', (e) => logger.warn('session_error', e));

  await session.join(options.code);

  if (options.statsSec > 0) {
    setInterval(() => {
      const stats = session.frameStats;
      if (!stats || stats.received === 0) {
        return;
      }
      console.log(`stats: ${stats.received} frames, ${stats.fps} fps, ${stats.kbps} kbps, `
        + `lost=${stats.lost} invalid=${stats.invalid} saved=${sink.saved}`);
    }, options.statsSec * 1000).unref();
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (line) => {
    await handleCommand(line.trim(), { session, sender, sink });
  });

  process.on('SIGINT', async () => {
    await session.close({ reason: 'viewer_interrupt' }).catch(() => {});
    process.exit(0);
  });
  return null;
}

async function handleCommand(line, { session, sender }) {
  const [command, ...rest] = line.split(/\s+/);
  const number = (value) => Number.parseInt(value ?? '0', 10);
  switch (command) {
    case 'm': sender.move(number(rest[0]), number(rest[1])); break;
    case 'c': sender.click('left'); break;
    case 'r': sender.click('right'); break;
    case 'b': sender.click('middle'); break;
    case 'd': sender.mouse('dblclick', { button: 'left', x: number(rest[0]), y: number(rest[1]) }); break;
    case 'w': sender.wheel(number(rest[0])); break;
    case 'k': sender.keystroke(rest.join(' ')); break;
    case 'C': sender.keystroke(rest.join(' '), { ctrl: true }); break;
    case 'S': sender.keystroke(rest.join(' '), { shift: true }); break;
    case 's': console.log(JSON.stringify({ session: session.diagnostics(), input: sender.stats }, null, 2)); break;
    case 'q':
      await session.close({ reason: 'viewer_quit' });
      process.exit(0);
      break;
    case '': break;
    default: console.log('Unknown command.'); break;
  }
}

/** JSON-lines replay: one input message per line (exact wire shape). */
function replayScript(file, sender) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  console.log(`Replaying ${lines.length} input messages from ${file}`);
  for (const line of lines) {
    try {
      const message = JSON.parse(line);
      const ok = message.kind === 'mouse'
        ? sender.mouse(message.action, message)
        : sender.key(message.action, message.key, message.modifiers);
      if (!ok) {
        console.log(`  skipped: ${line}`);
      }
    } catch (err) {
      console.log(`  invalid line (${err.message}): ${line}`);
    }
  }
}

main().then((code) => {
  if (code !== null) {
    // exitCode (not process.exit) so piped stdout still flushes.
    process.exitCode = code;
  }
}).catch((err) => {
  console.error(`Fatal: ${err?.message ?? err}`);
  process.exitCode = 1;
});
