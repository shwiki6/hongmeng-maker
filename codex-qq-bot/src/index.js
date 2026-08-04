import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfig } from './config.js';
import { CodexQQBot } from './bot.js';
import { createLogger } from './logger.js';

const log = createLogger('main');

for (const dir of [config.paths.dataDir, config.paths.logsDir, config.paths.workspacesDir, config.paths.mediaDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const pidFile = path.join(config.paths.logsDir, 'bot.pid');
const heartbeatFile = path.join(config.paths.logsDir, 'heartbeat');

function writePid() {
  try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}
}

function touchHeartbeat() {
  try { fs.writeFileSync(heartbeatFile, new Date().toISOString()); } catch {}
}

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  try { fs.appendFileSync(path.join(config.paths.logsDir, 'crash.log'), `${new Date().toISOString()} uncaughtException ${err?.stack || err}\n`); } catch {}
  // Let supervisor restart a clean process.
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection', err);
  try { fs.appendFileSync(path.join(config.paths.logsDir, 'crash.log'), `${new Date().toISOString()} unhandledRejection ${err?.stack || err}\n`); } catch {}
});

assertConfig();
writePid();
touchHeartbeat();
const heartbeatTimer = setInterval(touchHeartbeat, 15000);
heartbeatTimer.unref?.();

const bot = new CodexQQBot(config);
let shuttingDown = false;
const shutdown = (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down on ${sig}...`);
  clearInterval(heartbeatTimer);
  try { bot.stop(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => log.warn('ignored SIGHUP'));
process.on('SIGQUIT', () => log.warn('ignored SIGQUIT'));
// Keep process alive for short after uncaught to flush logs
process.on('exit', (code) => {
  try {
    fs.appendFileSync(path.join(config.paths.logsDir, 'crash.log'), `${new Date().toISOString()} process exit code=${code}\n`);
  } catch {}
});

log.info('boot', {
  appId: config.qq.appId,
  workdir: config.codex.workdir,
  codex: config.codex.bin,
  pid: process.pid,
  stream: config.bot.streamEnabled,
});

bot.start().catch((err) => {
  log.error('fatal', err);
  try { fs.appendFileSync(path.join(config.paths.logsDir, 'crash.log'), `${new Date().toISOString()} fatal ${err?.stack || err}\n`); } catch {}
  process.exit(1);
});
