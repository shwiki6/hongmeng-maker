#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../src/config.js';

function ok(msg) { console.log(`✔ ${msg}`); }
function bad(msg) { console.log(`✘ ${msg}`); }
function info(msg) { console.log(`• ${msg}`); }

console.log('Codex QQ Bot doctor');
console.log('project:', config.projectRoot);

if (config.qq.appId) ok(`QQBOT_APP_ID set (${config.qq.appId.slice(0, 4)}...)`);
else bad('QQBOT_APP_ID missing');
if (config.qq.clientSecret) ok('QQBOT_CLIENT_SECRET set');
else bad('QQBOT_CLIENT_SECRET missing');

const which = spawnSync('bash', ['-lc', `command -v ${config.codex.bin}`], { encoding: 'utf8' });
if (which.status === 0) ok(`codex bin: ${which.stdout.trim()}`);
else bad(`codex bin not found: ${config.codex.bin}`);

const ver = spawnSync(config.codex.bin, ['--version'], { encoding: 'utf8' });
if (ver.status === 0) ok(`codex version: ${ver.stdout.trim() || ver.stderr.trim()}`);
else bad(`codex --version failed: ${ver.stderr || ver.stdout}`);

if (fs.existsSync(config.codex.workdir)) ok(`workdir exists: ${config.codex.workdir}`);
else bad(`workdir missing: ${config.codex.workdir}`);

for (const d of [config.paths.dataDir, config.paths.logsDir, config.paths.mediaDir, config.paths.workspacesDir]) {
  if (fs.existsSync(d)) ok(`dir: ${d}`);
  else bad(`dir missing: ${d}`);
}

info(`stream=${config.bot.streamEnabled} thinking=${config.bot.streamThinking}`);
info(`media=${config.bot.mediaEnabled} send=${config.bot.mediaSendEnabled}`);
info(`keyboard=${config.bot.keyboardEnabled} markdown=${config.bot.markdownEnabled}`);
info(`guild=${config.bot.guildEnabled} autoWelcome=${config.bot.autoWelcome}`);
info(`requireMention=${config.qq.requireMention}`);
info(`allowFrom: ${config.qq.allowFrom.join(',') || '(open)'}`);
info(`groupAllowFrom: ${config.qq.groupAllowFrom.join(',') || '(open/fallback)'}`);
info(`model: ${config.codex.model || '(cli default)'}`);
info(`gateway session file: ${config.paths.gatewaySessionFile}`);

const pidFile = `${config.paths.logsDir}/bot.pid`;
if (fs.existsSync(pidFile)) {
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  try {
    process.kill(Number(pid), 0);
    ok(`bot process alive pid=${pid}`);
  } catch {
    bad(`bot pid file present but process dead (${pid})`);
  }
} else {
  bad('bot.pid missing (not running?)');
}
