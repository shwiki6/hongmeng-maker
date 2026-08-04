import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('svc');

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkPort(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/**
 * Persistent HTTP/static servers managed by the QQ bot process tree,
 * NOT by ephemeral `codex exec` turns (which get reaped on turn end).
 */
export class ServiceManager {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'services.json');
    this.services = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.services || []);
      for (const s of list) {
        if (!s?.id) continue;
        this.services.set(s.id, s);
      }
    } catch (err) {
      log.warn('load services failed', err?.message || err);
    }
  }

  #save() {
    const list = [...this.services.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ services: list }, null, 2));
  }

  list() {
    const out = [];
    for (const s of this.services.values()) {
      const alive = isPidAlive(s.pid);
      out.push({ ...s, alive });
    }
    return out;
  }

  get(idOrPort) {
    const key = String(idOrPort);
    if (this.services.has(key)) return this.services.get(key);
    const port = Number(key);
    if (Number.isFinite(port)) {
      for (const s of this.services.values()) {
        if (Number(s.port) === port) return s;
      }
    }
    return null;
  }

  /**
   * Start a detached static HTTP server that survives codex turn end.
   * Uses bot-owned setsid/detached child, records pid in data/services.json.
   */
  async startStatic({ rootDir, port = 8000, host = '0.0.0.0', id = null } = {}) {
    const absRoot = path.resolve(rootDir);
    if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
      throw new Error(`目录不存在: ${absRoot}`);
    }
    const p = Number(port);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      throw new Error(`非法端口: ${port}`);
    }
    const svcId = id || `static-${p}`;

    // If already managed and alive, return it.
    const existing = this.get(svcId) || this.get(p);
    if (existing && isPidAlive(existing.pid)) {
      const ok = await checkPort(p);
      if (ok) {
        return { ...existing, alive: true, reused: true };
      }
    }

    // Free old managed entry on same port.
    if (existing?.pid && isPidAlive(existing.pid)) {
      try { process.kill(existing.pid, 'SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }

    // Port occupied by foreign process?
    if (await checkPort(p)) {
      const rec = {
        id: svcId,
        kind: 'static-http',
        rootDir: absRoot,
        host,
        port: p,
        pid: null,
        foreign: true,
        startedAt: new Date().toISOString(),
        note: 'port already accepting connections (external process)',
      };
      this.services.set(svcId, rec);
      this.#save();
      return { ...rec, alive: true, reused: true };
    }

    const logFile = path.join(os.tmpdir(), `codex-qq-svc-${svcId}.log`);
    const outFd = fs.openSync(logFile, 'a');
    // Fully detach from parent and from any future codex session.
    // python -m http.server is simple and reliable for static sites.
    const child = spawn(
      process.env.PYTHON_BIN || 'python3',
      ['-u', '-m', 'http.server', String(p), '--bind', host],
      {
        cwd: absRoot,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: process.env,
      },
    );
    child.unref();
    try { fs.closeSync(outFd); } catch {}

    const pid = child.pid;
    // Wait briefly for listen
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await checkPort(p)) {
        ready = true;
        break;
      }
      if (!isPidAlive(pid)) break;
    }
    if (!ready) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      throw new Error(`服务启动失败: port=${p} log=${logFile}`);
    }

    const rec = {
      id: svcId,
      kind: 'static-http',
      rootDir: absRoot,
      host,
      port: p,
      pid,
      logFile,
      foreign: false,
      startedAt: new Date().toISOString(),
    };
    this.services.set(svcId, rec);
    this.#save();
    log.info('service started', rec);
    return { ...rec, alive: true, reused: false };
  }

  async stop(idOrPort) {
    const s = this.get(idOrPort);
    if (!s) throw new Error(`未找到服务: ${idOrPort}`);
    if (s.pid && isPidAlive(s.pid)) {
      try { process.kill(s.pid, 'SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 250));
      if (isPidAlive(s.pid)) {
        try { process.kill(s.pid, 'SIGKILL'); } catch {}
      }
    }
    this.services.delete(s.id);
    this.#save();
    return s;
  }

  async ensureAlive(idOrPort) {
    const s = this.get(idOrPort);
    if (!s) return null;
    const portOk = await checkPort(s.port);
    if (portOk) return { ...s, alive: true };
    if (s.kind === 'static-http' && s.rootDir) {
      return this.startStatic({
        rootDir: s.rootDir,
        port: s.port,
        host: s.host || '0.0.0.0',
        id: s.id,
      });
    }
    return { ...s, alive: false };
  }

  formatStatus(lanIp = '') {
    const list = this.list();
    if (!list.length) return '当前没有机器人托管的持久服务。\n用 /serve <目录> [端口] 启动。';
    return list.map((s) => {
      const urls = [
        `http://127.0.0.1:${s.port}/`,
        lanIp ? `http://${lanIp}:${s.port}/` : null,
      ].filter(Boolean).join(' | ');
      return [
        `- ${s.id}`,
        `  dir: ${s.rootDir}`,
        `  port: ${s.port}`,
        `  pid: ${s.pid || '-'}`,
        `  alive: ${s.alive ? 'yes' : 'no'}`,
        `  url: ${urls}`,
      ].join('\n');
    }).join('\n');
  }
}

export function detectLanIp() {
  try {
    const ifs = os.networkInterfaces();
    for (const arr of Object.values(ifs)) {
      for (const x of arr || []) {
        if (x && x.family === 'IPv4' && !x.internal) return x.address;
      }
    }
  } catch {}
  return '';
}
