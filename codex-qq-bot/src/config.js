import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(PROJECT_ROOT, '.env'));

function csv(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function int(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  projectRoot: PROJECT_ROOT,
  qq: {
    appId: (process.env.QQBOT_APP_ID || '').trim(),
    clientSecret: (process.env.QQBOT_CLIENT_SECRET || process.env.QQBOT_APP_SECRET || '').trim(),
    allowFrom: csv('QQBOT_ALLOW_FROM'),
    groupAllowFrom: csv('QQBOT_GROUP_ALLOW_FROM'),
    requireMention: bool('QQBOT_REQUIRE_MENTION', true),
  },
  codex: {
    bin: (process.env.CODEX_BIN || 'codex').trim(),
    workdir: path.resolve(process.env.CODEX_WORKDIR || PROJECT_ROOT),
    model: (process.env.CODEX_MODEL || '').trim(),
    sandbox: (process.env.CODEX_SANDBOX || 'danger-full-access').trim(),
    bypassApprovals: bool('CODEX_BYPASS_APPROVALS', true),
    timeoutMs: int('CODEX_TIMEOUT_MS', 600000),
    // Keep group turns inside QQ's passive-reply window.
    groupTimeoutMs: int('CODEX_GROUP_TIMEOUT_MS', 240000),
    extraArgs: (process.env.CODEX_EXTRA_ARGS || '').trim(),
  },
  bot: {
    name: process.env.BOT_NAME || 'Codex',
    replyPrefix: process.env.REPLY_PREFIX || '',
    maxReplyChars: int('MAX_REPLY_CHARS', 1800),
    concurrency: Math.max(1, int('CONCURRENCY', 2)),
    typingIntervalSec: Math.max(5, int('TYPING_INTERVAL_SEC', 20)),
    // C2C stream_messages (QQ private chat only)
    streamEnabled: bool('STREAM_ENABLED', true),
    streamThrottleMs: Math.max(300, int('STREAM_THROTTLE_MS', 500)),
    // Stream process/thinking steps (commands/tools/notes) before final answer
    streamThinking: bool('STREAM_THINKING', true),
    streamProcessMaxChars: Math.max(200, int('STREAM_PROCESS_MAX_CHARS', 700)),
    streamProcessMaxLines: Math.max(3, int('STREAM_PROCESS_MAX_LINES', 8)),
    // Media
    mediaEnabled: bool('MEDIA_ENABLED', true),
    mediaSendEnabled: bool('MEDIA_SEND_ENABLED', true),
    mediaDownloadTimeoutMs: int('MEDIA_DOWNLOAD_TIMEOUT_MS', 60000),
    mediaMaxOutbound: Math.max(1, int('MEDIA_MAX_OUTBOUND', 4)),
    // Keyboard / interaction
    keyboardEnabled: bool('KEYBOARD_ENABLED', true),
    // Passive reply limiter (per inbound msg_id)
    replyLimit: Math.max(1, int('PASSIVE_REPLY_LIMIT', 4)),
    replyTtlMs: int('PASSIVE_REPLY_TTL_MS', 60 * 60 * 1000),
    // Lifecycle notify to allowlist C2C peers (empty = only log)
    lifecycleNotify: bool('LIFECYCLE_NOTIFY', false),
    // Welcome text on FRIEND_ADD (empty = default)
    welcomeText: (process.env.WELCOME_TEXT || '').trim(),
    // Optional markdown replies (requires platform permission)
    markdownEnabled: bool('MARKDOWN_ENABLED', false),
    // Dedup redelivered gateway messages
    dedupTtlMs: int('DEDUP_TTL_MS', 10 * 60 * 1000),
    // Send retry
    sendRetries: Math.max(0, int('SEND_RETRIES', 2)),
    // Guild/channel support
    guildEnabled: bool('GUILD_ENABLED', true),
    // Auto-welcome new friends
    autoWelcome: bool('AUTO_WELCOME', true),
  },
  paths: {
    dataDir: path.join(PROJECT_ROOT, 'data'),
    logsDir: path.join(PROJECT_ROOT, 'logs'),
    mediaDir: path.join(PROJECT_ROOT, 'media'),
    gatewaySessionFile: path.join(PROJECT_ROOT, 'data', 'gateway-session.json'),
    sessionsFile: path.join(PROJECT_ROOT, 'data', 'sessions.json'),
    workspacesDir: path.join(PROJECT_ROOT, 'workspaces'),
  },
};

export function assertConfig() {
  if (!config.qq.appId || !config.qq.clientSecret) {
    throw new Error('Missing QQBOT_APP_ID / QQBOT_CLIENT_SECRET in .env');
  }
}
