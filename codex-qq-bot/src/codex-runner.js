import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('codex');

function parseExtraArgs(raw) {
  if (!raw) return [];
  return raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) || [];
}

function extractSessionId(text = '') {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload || {};
      if (obj.type === 'session_meta') {
        return payload.session_id || payload.id || null;
      }
      if (obj.type === 'thread.started' && obj.thread_id) return obj.thread_id;
      if (payload.session_id) return payload.session_id;
      if (obj.session_id) return obj.session_id;
      if (obj.thread_id) return obj.thread_id;
    } catch {
      // ignore
    }
  }
  const m = text.match(/"session_id"\s*:\s*"([0-9a-fA-F-]{16,})"/)
    || text.match(/"thread_id"\s*:\s*"([0-9a-fA-F-]{16,})"/);
  return m?.[1] || null;
}

function findLatestSessionId(workdir, afterMs) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return null;
  let best = null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs + 1000 < afterMs) continue;
      const m = ent.name.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
      if (!m) continue;
      let score = st.mtimeMs;
      try {
        const head = fs.readFileSync(full, 'utf8').slice(0, 4000);
        if (workdir && head.includes(workdir)) score += 1e15;
        if (head.includes('codex_exec')) score += 1e14;
      } catch {}
      if (!best || score > best.score) best = { id: m[1], score };
    }
  }
  return best?.id || null;
}

function pickItemText(item = {}) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.summary === 'string' && item.summary.trim()) return item.summary.trim();
  if (typeof item.reasoning === 'string' && item.reasoning.trim()) return item.reasoning.trim();
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((c) => c?.text || c?.input_text || c?.content || c?.summary || '')
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (Array.isArray(item.summary)) {
    const text = item.summary
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

function shortOneLine(s, max = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function processLineFromItem(item = {}, phase = 'started') {
  const type = item.type || item.kind || '';
  if (!type) return '';

  if (type === 'command_execution' || type === 'command' || type === 'bash' || type === 'shell') {
    let cmd = String(item.command || item.cmd || item.text || '');
    // Prefer the meaningful binary/script, drop huge heredoc bodies.
    cmd = cmd.replace(/python3\s+-\s*<<['"]?\w+['"]?[\s\S]*$/i, 'python3 -');
    cmd = cmd.replace(/\/bin\/bash\s+-lc\s+/g, '');
    cmd = cmd.replace(/^['"]|['"]$/g, '');
    cmd = shortOneLine(cmd, 70);
    if (phase === 'completed') {
      const code = item.exit_code ?? item.exitCode;
      const suffix = code === undefined || code === null ? '' : `(${code})`;
      return cmd ? `⚙️ 完成${suffix} ${cmd}` : `⚙️ 命令完成${suffix}`;
    }
    return cmd ? `⚙️ 执行 ${cmd}` : '⚙️ 执行命令中…';
  }

  if (type === 'file_change' || type === 'patch' || type === 'apply_patch') {
    const files = item.files || item.paths || item.changes || [];
    let names = '';
    if (Array.isArray(files) && files.length) {
      names = files
        .map((f) => (typeof f === 'string' ? f : f?.path || f?.file || ''))
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
    }
    return names ? `📝 修改文件: ${shortOneLine(names, 100)}` : '📝 正在修改文件…';
  }

  if (type === 'web_search' || type === 'search') {
    const q = shortOneLine(item.query || item.text || '');
    return q ? `🔍 检索: ${q}` : '🔍 正在检索…';
  }

  if (type === 'mcp_tool_call' || type === 'tool_call' || type === 'function_call') {
    const name = item.name || item.tool || item.server || item.function || '';
    return name ? `🧰 调用工具: ${name}` : '🧰 调用工具中…';
  }

  if (type === 'reasoning' || type === 'thought' || type === 'thinking') {
    const text = shortOneLine(pickItemText(item), 220);
    return text ? `💭 ${text}` : '💭 思考中…';
  }

  if (type === 'agent_message' || type === 'message') return '';
  if (phase === 'started') return `⏳ ${type}`;
  return '';
}

function composeLiveText({ processLog, answerText, thinkingEnabled }) {
  const answer = String(answerText || '').trim();
  if (!thinkingEnabled) {
    return answer || (processLog.length ? processLog[processLog.length - 1] : 'Codex 处理中…');
  }
  const parts = [];
  if (processLog.length) {
    parts.push('**过程**');
    for (const line of processLog) parts.push(`- ${line}`);
  }
  if (answer) {
    if (parts.length) parts.push('');
    parts.push('**回复**');
    parts.push(answer);
  }
  if (!parts.length) return 'Codex 处理中…';
  return parts.join('\n');
}

export class CodexRunner {
  constructor(config) {
    this.config = config;
  }

  #newSessionArgs(outFile, prompt, images) {
    const c = this.config.codex;
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--color', 'never',
      '--json',
    ];
    if (c.workdir) args.push('-C', c.workdir);
    if (c.bypassApprovals) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (c.sandbox) {
      args.push('-s', c.sandbox);
    }
    args.push(...parseExtraArgs(c.extraArgs));
    for (const img of images) args.push('-i', img);
    args.push('-o', outFile, prompt);
    return args;
  }

  #resumeArgs(sessionId, outFile, prompt, images) {
    const c = this.config.codex;
    const args = [
      'exec',
      'resume',
      '--skip-git-repo-check',
      '--json',
    ];
    if (c.bypassApprovals) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    for (const img of images) args.push('-i', img);
    args.push('-o', outFile, sessionId, prompt);
    return args;
  }

  /**
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string|null} [opts.sessionId]
   * @param {string[]} [opts.images]
   * @param {(info: {text: string, status?: string, kind?: string, sessionId?: string|null, event?: any}) => (void|Promise<void>)} [opts.onPartial]
   * @param {number} [opts.timeoutMs]
   */
  async run({ prompt, sessionId = null, images = [], onPartial = null, signal = null, timeoutMs = null }) {
    const outFile = path.join(
      os.tmpdir(),
      `codex-qq-bot-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );

    const startedAt = Date.now();
    if (signal?.aborted) {
      throw new Error('任务已取消');
    }

    const thinkingEnabled = this.config.bot?.streamThinking !== false;
    const maxProcessLines = Math.max(3, Number(this.config.bot?.streamProcessMaxLines || 8));
    const live = {
      sessionId: sessionId || null,
      processLog: [],
      answerText: '',
      status: 'Codex 处理中…',
      liveText: 'Codex 处理中…',
      seenProcess: new Set(),
    };

    const rebuild = () => {
      live.liveText = composeLiveText({
        processLog: live.processLog,
        answerText: live.answerText,
        thinkingEnabled,
      });
    };

    const addProcess = (line) => {
      // Keep process lines short so final answer is not crowded out of QQ stream limits.
      const s = shortOneLine(line, 90);
      if (!s) return false;
      if (live.seenProcess.has(s)) return false;
      // Also dedup "执行 X" vs "完成 X" partially? keep both.
      if (live.processLog.length >= maxProcessLines) {
        // Drop oldest non-first line to keep growing while staying compact.
        if (live.processLog.length >= 2) {
          const removed = live.processLog.splice(1, 1)[0];
          live.seenProcess.delete(removed);
        } else {
          return false;
        }
      }
      live.seenProcess.add(s);
      live.processLog.push(s);
      live.status = s;
      rebuild();
      return true;
    };

    const emit = async (event, kind = 'status') => {
      if (!onPartial) return;
      try {
        await onPartial({
          text: live.liveText,
          status: live.status,
          kind,
          sessionId: live.sessionId,
          event,
        });
      } catch (err) {
        log.warn('onPartial failed', err?.message || err);
      }
    };

    // Immediate first progress so QQ stream can open quickly.
    if (onPartial && thinkingEnabled) {
      addProcess('⏳ 已收到，开始处理…');
      await emit({ type: 'local.progress' }, 'thinking');
    }

    const handleLine = async (line) => {
      const raw = String(line || '').trim();
      if (!raw) return;
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }

      if (obj.type === 'thread.started' && obj.thread_id) {
        live.sessionId = obj.thread_id;
      }
      if (obj.thread_id && !live.sessionId) live.sessionId = obj.thread_id;
      if (obj.session_id && !live.sessionId) live.sessionId = obj.session_id;

      if (obj.type === 'turn.started') {
        if (addProcess('🚀 开始本轮推理')) await emit(obj, 'thinking');
        return;
      }

      if (obj.type === 'error' && obj.message) {
        if (addProcess(`⚠️ ${shortOneLine(obj.message, 180)}`)) await emit(obj, 'thinking');
        return;
      }

      if (obj.type === 'item.started' || obj.type === 'item.updated' || obj.type === 'item.completed') {
        const item = obj.item || {};
        const itemType = item.type || '';
        const phase = obj.type === 'item.completed' ? 'completed' : obj.type === 'item.updated' ? 'updated' : 'started';

        if (itemType === 'agent_message' || itemType === 'message') {
          const text = pickItemText(item);
          if (text) {
            // Intermediate notes often arrive before the final -o answer.
            // Keep them in process if thinking is on; promote completed messages to answer.
            if (phase === 'completed') {
              live.answerText = live.answerText
                ? `${live.answerText}\n\n${text}`
                : text;
              rebuild();
              await emit(obj, 'message');
            } else {
              // Partial/update: treat as growing answer if we already have one, else process note.
              if (live.answerText) {
                // Only grow answer if it's a prefix extension.
                if (text.startsWith(live.answerText) || live.answerText.startsWith(text.slice(0, Math.min(20, text.length)))) {
                  live.answerText = text.length >= live.answerText.length ? text : live.answerText;
                } else {
                  live.answerText = `${live.answerText}\n\n${text}`;
                }
                rebuild();
                await emit(obj, 'message');
              } else if (thinkingEnabled) {
                if (addProcess(`💬 ${shortOneLine(text, 70)}`)) await emit(obj, 'thinking');
              } else {
                live.answerText = text;
                rebuild();
                await emit(obj, 'message');
              }
            }
            return;
          }
        }

        if (itemType === 'reasoning' || itemType === 'thought' || itemType === 'thinking') {
          const text = pickItemText(item);
          if (text && thinkingEnabled) {
            // Stream reasoning as process lines; split long text into short chunks for readability.
            const clipped = shortOneLine(text, 260);
            if (addProcess(`💭 ${clipped}`)) await emit(obj, 'thinking');
            return;
          }
          if (thinkingEnabled && addProcess('💭 思考中…')) await emit(obj, 'thinking');
          return;
        }

        const pLine = processLineFromItem(item, phase);
        if (pLine && thinkingEnabled) {
          if (addProcess(pLine)) await emit(obj, 'thinking');
        }
        return;
      }

      // Fallback shapes.
      const text = this.#extractEventText(obj);
      if (text) {
        live.answerText = text;
        rebuild();
        await emit(obj, 'message');
      }
    };

    let resumedSessionId = sessionId;
    let args = resumedSessionId
      ? this.#resumeArgs(resumedSessionId, outFile, prompt, images)
      : this.#newSessionArgs(outFile, prompt, images);
    log.info(`spawn ${this.config.codex.bin} ${args.join(' ')}`);
    let result = await this.#spawn(args, handleLine, signal, timeoutMs || this.config.codex.timeoutMs);

    // Saved sessions can disappear after a Codex home migration or cleanup.
    // Continue the user's request in a fresh session rather than leaving it unanswered.
    const resumeError = `${result.stderr || ''}\n${result.stdout || ''}`;
    if (resumedSessionId && result.code !== 0 && /thread\/resume failed|no rollout found/i.test(resumeError)) {
      log.warn(`saved session unavailable; starting a new session: ${resumedSessionId}`);
      resumedSessionId = null;
      live.sessionId = null;
      args = this.#newSessionArgs(outFile, prompt, images);
      log.info(`retry ${this.config.codex.bin} ${args.join(' ')}`);
      result = await this.#spawn(args, handleLine, signal, timeoutMs || this.config.codex.timeoutMs);
    }
    const spawnMs = Date.now() - startedAt;

    let lastMessage = '';
    try {
      if (fs.existsSync(outFile)) lastMessage = fs.readFileSync(outFile, 'utf8').trim();
    } catch {
      lastMessage = '';
    }
    try { fs.unlinkSync(outFile); } catch {}

    let newSessionId =
      live.sessionId ||
      extractSessionId(result.stdout) ||
      extractSessionId(result.stderr) ||
      resumedSessionId ||
      findLatestSessionId(this.config.codex.workdir, startedAt - 2000);

    if (!lastMessage) {
      lastMessage = this.#extractFinalText(result.stdout) || live.answerText || '';
    }
    if (signal?.aborted) {
      throw new Error('任务已取消');
    }
    if (!lastMessage && result.code !== 0) {
      const errText = (result.stderr || result.stdout || '').trim();
      log.error(`codex failed code=${result.code} spawnMs=${spawnMs}`);
      throw new Error(`codex exit ${result.code}${errText ? `: ${errText.slice(0, 500)}` : ''}`);
    }
    if (!lastMessage) lastMessage = '(Codex 无文本输出)';

    // Prefer official last message for the answer section.
    live.answerText = lastMessage;
    rebuild();

    log.info(`codex finished code=${result.code} spawnMs=${spawnMs} session=${newSessionId || '-'} replyChars=${lastMessage.length} processSteps=${live.processLog.length}`);

    if (onPartial) {
      try {
        await onPartial({
          text: live.liveText,
          status: '',
          kind: 'final',
          sessionId: newSessionId,
          event: { type: 'final' },
        });
      } catch {}
    }

    return {
      text: lastMessage,
      // Full streamed composition (process + answer) for optional use.
      streamText: live.liveText,
      processLog: live.processLog,
      sessionId: newSessionId,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      spawnMs,
    };
  }

  #extractEventText(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const p = obj.payload || obj;
    if (p?.type === 'message' && p.role === 'assistant') {
      const parts = p.content || [];
      return parts.map((c) => c.text || c.input_text || '').filter(Boolean).join('\n').trim();
    }
    if (obj.type === 'item.completed' && obj.item?.text) return String(obj.item.text).trim();
    if (p?.type === 'agent_message' && p.text) return String(p.text).trim();
    if (obj.type === 'message' && obj.role === 'assistant' && obj.content) {
      return (obj.content || []).map((c) => c.text || '').join('\n').trim();
    }
    return '';
  }

  #extractFinalText(jsonlText = '') {
    let last = '';
    for (const line of jsonlText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const text = this.#extractEventText(obj);
        if (text) last = text;
      } catch {}
    }
    return last.trim();
  }

  #spawn(args, onLine, signal = null, timeoutMs = this.config.codex.timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(this.config.codex.bin, args, {
        cwd: this.config.codex.workdir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      let chain = Promise.resolve();
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
        resolve(payload);
      };

      const killTree = (sig = 'SIGTERM') => {
        try { child.kill(sig); } catch {}
      };

      const timer = setTimeout(() => {
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 3000);
      }, timeoutMs);

      const onAbort = () => {
        log.warn('codex abort signal received, killing child');
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 2000);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const handleChunk = (chunk) => {
        const s = chunk.toString('utf8');
        stdout += s;
        if (!onLine) return;
        lineBuf += s;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          chain = chain.then(() => onLine(line)).catch(() => {});
        }
      };

      child.stdout.on('data', handleChunk);
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (lineBuf.trim() && onLine) {
          chain = chain.then(() => onLine(lineBuf)).catch(() => {});
          lineBuf = '';
        }
        chain.finally(() => finish({ code: code ?? 1, stdout, stderr, aborted: Boolean(signal?.aborted) }));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ code: 1, stdout, stderr: String(err), aborted: Boolean(signal?.aborted) });
      });
    });
  }
}
