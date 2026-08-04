import fs from 'node:fs';
import path from 'node:path';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { FULL_INTENTS, ReplyLimiter } from '@tencent-connect/qqbot-nodejs/protocol';
import { CodexRunner } from './codex-runner.js';
import { SessionStore } from './session-store.js';
import { KeyedQueue } from './queue.js';
import { stripMentions, chunkText, parseCommand } from './text.js';
import { createLogger } from './logger.js';
import { ServiceManager, detectLanIp } from './service-manager.js';
import {
  downloadAttachments,
  extractQuotedText,
  extractOutboundMedia,
  createZipArchive,
  formatAttachmentPrompt,
  mediaKindFromContentType,
} from './media.js';
import { commandKeyboard, servicesKeyboard } from './keyboard.js';
import { createGatewaySessionPersistence } from './gateway-session.js';
import { MessageDeduper } from './dedup.js';
import { withRetry } from './retry.js';
import { GuildApi } from './guild-api.js';
import { handleGuildCommand, isGuildCommand, guildHelpText } from './guild-commands.js';

const log = createLogger('qq');

const LIFECYCLE_EVENTS = new Set([
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'MESSAGE_REACTION_ADD',
  'MESSAGE_REACTION_REMOVE',
  'GUILD_CREATE',
  'GUILD_UPDATE',
  'GUILD_DELETE',
]);

export class CodexQQBot {
  constructor(config) {
    this.config = config;
    this.sessions = new SessionStore(config.paths.sessionsFile);
    this.services = new ServiceManager(config.paths.dataDir);
    this.codex = new CodexRunner(config);
    this.queue = new KeyedQueue(config.bot.concurrency);
    this.replyLimiter = new ReplyLimiter({
      limit: config.bot.replyLimit,
      ttlMs: config.bot.replyTtlMs,
    });
    this.sentMessages = new Map(); // peerKey -> [{id, at}]
    this.deduper = new MessageDeduper({ ttlMs: config.bot.dedupTtlMs });
    this.activeJobs = new Map(); // peerKey -> { controller, startedAt, prompt }
    this.gatewaySession = createGatewaySessionPersistence(config.paths.gatewaySessionFile);
    this.guildApi = null; // init after bot.api is usable in start()
    // Prefer group/c2c intents; FULL_INTENTS also includes guilds/interactions.
    this.bot = new QQBot({
      appId: config.qq.appId,
      appSecret: config.qq.clientSecret,
      accountId: 'codex-qq-bot',
      markdownSupport: Boolean(config.bot.markdownEnabled),
      intents: FULL_INTENTS,
      sessionPersistence: this.gatewaySession,
      logger: {
        debug: (...a) => log.debug(...a),
        info: (...a) => log.info(...a),
        warn: (...a) => log.warn(...a),
        error: (...a) => log.error(...a),
      },
    });
  }

  async start() {
    fs.mkdirSync(this.config.paths.mediaDir, { recursive: true });

    this.bot.on('ready', (data) => log.info('QQ gateway ready', data));
    this.bot.on('resumed', (data) => log.info('QQ gateway resumed', data));
    this.bot.on('error', (err) => log.error('QQ bot error', err));

    this.bot.on('rawEvent', (ctx) => {
      try {
        const t = ctx?.eventType || 'unknown';
        const preview = JSON.stringify(ctx?.data ?? null);
        log.info(`rawEvent ${t}: ${preview.slice(0, 800)}`);
        if (LIFECYCLE_EVENTS.has(t)) {
          void this.#onLifecycle(t, ctx?.data);
        }
      } catch (err) {
        log.warn('rawEvent log failed', err);
      }
    });

    this.bot.on('message', async (_ctx, msg) => {
      log.info('inbound message', {
        kind: msg?.kind,
        senderId: msg?.senderId,
        groupOpenid: msg?.groupOpenid,
        messageId: msg?.messageId,
        content: msg?.content,
        mentions: (msg?.mentions || [])
          .map((mention) => mention?.member_openid || mention?.user_openid || mention?.id)
          .filter(Boolean),
        hasReplyTarget: Boolean(msg?.replyTarget),
        attachments: (msg?.attachments || []).length,
        rawEventType: msg?.rawEventType,
      });
      try {
        await this.#onMessage(msg);
      } catch (err) {
        log.error('message handler failed', err);
        try {
          if (msg?.replyTarget) {
            await this.#safeSendText(msg.replyTarget, `处理失败: ${err.message || err}`);
          }
        } catch (sendErr) {
          log.error('failed to send error reply', sendErr);
        }
      }
    });

    this.bot.on('interaction', async (_ctx, event) => {
      try {
        await this.#onInteraction(event);
      } catch (err) {
        log.error('interaction handler failed', err);
        try {
          if (event?.id) await this.bot.acknowledgeInteraction(event.id, 1);
        } catch {}
      }
    });

    this.guildApi = new GuildApi(this.bot.api);

    log.info('starting QQ bot...');
    await this.bot.start();
  }

  stop() {
    this.bot.stop();
  }

  #allowed(msg) {
    const isGroup = msg.kind === 'group';
    const list = isGroup
      ? (this.config.qq.groupAllowFrom.length ? this.config.qq.groupAllowFrom : this.config.qq.allowFrom)
      : this.config.qq.allowFrom;
    if (!list.length) return true;
    if (list.includes('*')) return true;
    return list.includes(msg.senderId);
  }

  #peer(msg) {
    if (msg.kind === 'group') {
      return { kind: 'group', id: msg.groupOpenid || msg.replyTarget?.targetId || 'unknown' };
    }
    if (msg.kind === 'guild') {
      return { kind: 'guild', id: msg.channelId || msg.guildId || 'unknown' };
    }
    if (msg.kind === 'dm') {
      return { kind: 'dm', id: msg.guildId || msg.senderId || 'unknown' };
    }
    return { kind: 'c2c', id: msg.senderId };
  }

  #peerKey(peer) {
    return `${peer.kind}:${peer.id}`;
  }

  #sessionPeer(msg, replyPeer) {
    if (replyPeer.kind !== 'group') return replyPeer;
    const actors = this.#groupActors(msg, replyPeer);
    const targetId = actors?.mentioned?.[0] || msg.senderId;
    const actor = actors?.actors?.[targetId];
    const actorKey = actor?.id || targetId;
    return {
      kind: 'group',
      id: `${replyPeer.id}:actor:${actorKey}`,
    };
  }

  #groupActors(msg, peer) {
    if (peer.kind !== 'group') return null;

    const st = this.sessions.get(peer.kind, peer.id) || {};
    const actors = { ...(st.groupActors || {}) };
    const participants = new Map();
    const add = (member, fallbackName = '') => {
      const id = member?.member_openid || member?.user_openid || member?.id;
      if (!id || member?.bot || member?.is_you) return;
      participants.set(id, {
        name: member?.nickname || member?.username || fallbackName || '',
      });
    };

    add({ member_openid: msg.senderId }, msg.senderName);
    for (const mention of msg.mentions || []) add(mention);

    let next = Object.values(actors)
      .map((actor) => Number.parseInt(String(actor.id || '').replace(/^人物/, ''), 10))
      .filter(Number.isFinite)
      .reduce((max, value) => Math.max(max, value), 0) + 1;
    let changed = false;
    for (const [memberId, info] of participants) {
      const actor = actors[memberId] || { id: `人物${String(next++).padStart(3, '0')}` };
      if (info.name && actor.name !== info.name) {
        actor.name = info.name;
        changed = true;
      }
      actors[memberId] = actor;
      if (!st.groupActors?.[memberId]) changed = true;
    }

    if (changed) {
      this.sessions.set(peer.kind, peer.id, { groupActors: actors });
    }

    return {
      actors,
      sender: actors[msg.senderId] || null,
      mentioned: [...(msg.mentions || [])]
        .filter((mention) => !mention?.bot && !mention?.is_you)
        .map((mention) => mention?.member_openid || mention?.user_openid || mention?.id)
        .filter((id) => id && actors[id] && id !== msg.senderId),
    };
  }

  #rememberSent(peer, messageId) {
    if (!messageId) return;
    const key = this.#peerKey(peer);
    const list = this.sentMessages.get(key) || [];
    list.unshift({ id: messageId, at: Date.now() });
    this.sentMessages.set(key, list.slice(0, 20));
  }

  #lastSentId(peer) {
    const list = this.sentMessages.get(this.#peerKey(peer)) || [];
    return list[0]?.id || null;
  }

  /**
   * Send text with passive-reply limit awareness.
   * When passive replies are exhausted/expired, strip msgId and go proactive.
   */
  async #safeSendText(target, content, opts = {}) {
    let t = { ...target };
    let usePassive = Boolean(t.msgId);
    if (t.msgId) {
      const check = this.replyLimiter.checkLimit(t.msgId);
      if (!check.allowed) {
        log.warn(`passive limit fallback: ${check.fallbackReason || check.message}`);
        // Keep channel/guild/dm ids for proactive channel/dm sends.
        t = {
          scope: t.scope,
          targetId: t.targetId,
          channelId: t.channelId,
          guildId: t.guildId,
        };
        usePassive = false;
      }
    }

    const sendOnce = async () => {
      // Guild channel / DM use dedicated APIs (no ReplyTarget scope).
      if (t.scope === 'guild' || t.scope === 'channel') {
        const channelId = t.channelId || t.targetId;
        return this.bot.sendChannelMessage(channelId, content, {
          msgId: usePassive ? t.msgId : undefined,
          keyboard: opts.keyboard && this.config.bot.keyboardEnabled ? opts.keyboard : undefined,
          messageReference: opts.quote && usePassive && t.msgId ? t.msgId : undefined,
        });
      }
      if (t.scope === 'dm') {
        const guildId = t.guildId || t.targetId;
        return this.bot.sendDmMessage(guildId, content, { msgId: usePassive ? t.msgId : undefined });
      }
      if (opts.keyboard && this.config.bot.keyboardEnabled) {
        return this.bot.sendTextWithKeyboard(t, content, opts.keyboard);
      }
      if (opts.markdown && this.config.bot.markdownEnabled) {
        return this.bot.sendMarkdown(t, content, opts.keyboard ? { keyboard: opts.keyboard } : undefined);
      }
      // Prefer quote/reference when available
      if (opts.quote && usePassive && t.msgId) {
        return this.bot.send({
          target: t,
          content,
          messageReference: { message_id: t.msgId },
        });
      }
      return this.bot.sendText(t, content);
    };

    const res = await withRetry(sendOnce, {
      retries: this.config.bot.sendRetries,
      label: 'sendText',
      onRetry: (err, n, delay) => log.warn(`send retry #${n} in ${delay}ms: ${err?.message || err}`),
    });
    // Record only after a successful passive send so failed retries keep quota.
    if (usePassive && t.msgId) {
      this.replyLimiter.record(t.msgId);
    }
    if (res?.id && opts.peer) this.#rememberSent(opts.peer, res.id);
    return res;
  }

  async #safeSendChunks(target, text, opts = {}) {
    const chunks = chunkText(text || '(空响应)', this.config.bot.maxReplyChars);
    let last = null;
    for (const part of chunks) {
      last = await this.#safeSendText(target, part, opts);
    }
    return last;
  }

  #groupMentionsBot(msg) {
    // GROUP_AT_MESSAGE_CREATE already implies @bot.
    if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true;
    const content = String(msg.content || '');
    if (/<@!?/.test(content) || /@\S+/.test(content)) return true;
    if (Array.isArray(msg.mentions) && msg.mentions.length) return true;
    return false;
  }

  async #onLifecycle(type, data) {
    log.info(`lifecycle ${type}`, data);

    // Auto welcome new C2C friends.
    if (type === 'FRIEND_ADD' && this.config.bot.autoWelcome) {
      const openid = data?.openid || data?.user_openid || data?.author?.user_openid;
      if (openid) {
        const welcome = this.config.bot.welcomeText || [
          `你好，我是 ${this.config.bot.name} QQ 机器人。`,
          '直接发消息即可与 Codex CLI 协作。',
          '发送 /help 查看命令与快捷按钮。',
        ].join('\n');
        try {
          await this.bot.sendText({ scope: 'c2c', targetId: openid }, welcome);
          if (this.config.bot.keyboardEnabled) {
            await this.bot.sendTextWithKeyboard(
              { scope: 'c2c', targetId: openid },
              '快捷操作：',
              commandKeyboard(),
            );
          }
        } catch (err) {
          log.warn('welcome failed', err?.message || err);
        }
      }
    }

    if (type === 'GROUP_ADD_ROBOT') {
      const groupOpenid = data?.group_openid || data?.groupOpenid;
      log.info(`added to group ${groupOpenid || '?'}`);
    }
    if (type === 'GUILD_CREATE' || type === 'GUILD_UPDATE') {
      log.info(`guild event ${type} id=${data?.id || data?.guild_id || '?'}`);
    }
    if (type === 'GUILD_DELETE') {
      log.info(`left/deleted guild ${data?.id || data?.guild_id || '?'}`);
    }
    if (type === 'CHANNEL_CREATE' || type === 'CHANNEL_UPDATE' || type === 'CHANNEL_DELETE') {
      log.info(`channel event ${type} id=${data?.id || '?'} guild=${data?.guild_id || '?'}`);
    }
    if (type === 'GUILD_MEMBER_ADD' || type === 'GUILD_MEMBER_UPDATE' || type === 'GUILD_MEMBER_REMOVE') {
      const uid = data?.user?.id || data?.user_id || '?';
      log.info(`member event ${type} user=${uid} guild=${data?.guild_id || '?'}`);
    }

    if (!this.config.bot.lifecycleNotify) return;
    const allow = this.config.qq.allowFrom.filter((x) => x && x !== '*');
    if (!allow.length) return;
    const brief = (() => {
      try { return JSON.stringify(data).slice(0, 300); } catch { return String(data); }
    })();
    for (const openid of allow.slice(0, 5)) {
      try {
        await this.bot.sendText({ scope: 'c2c', targetId: openid }, `事件 ${type}\n${brief}`);
      } catch (err) {
        log.warn(`lifecycle notify failed ${openid}`, err?.message || err);
      }
    }
  }

  async #onInteraction(event) {
    const buttonData = event?.data?.resolved?.button_data
      || event?.data?.resolved?.button_id
      || '';
    const buttonId = event?.data?.resolved?.button_id || '';
    log.info('interaction', { id: event?.id, buttonId, buttonData, scene: event?.scene });

    // ACK within 5s as required by platform.
    try {
      await this.bot.acknowledgeInteraction(event.id, 0);
    } catch (err) {
      log.warn('acknowledgeInteraction failed', err?.message || err);
    }

    const text = String(buttonData || '').trim();
    if (!text) return;

    // Reconstruct a pseudo inbound message so commands reuse the same path.
    const isGroup = Boolean(event.group_openid);
    const senderId = isGroup
      ? (event.group_member_openid || event.user_openid || '')
      : (event.user_openid || '');
    const targetId = isGroup ? event.group_openid : (event.user_openid || senderId);
    if (!targetId || !senderId) {
      log.warn('interaction missing target/sender', event);
      return;
    }

    // Prefer the source message id so C2C stream / typing / passive reply work.
    const sourceMsgId = event.data?.resolved?.message_id
      || event.message_id
      || event.msg_id
      || null;
    const msg = {
      kind: isGroup ? 'group' : 'c2c',
      senderId,
      groupOpenid: event.group_openid,
      content: text,
      messageId: sourceMsgId || event.id,
      timestamp: event.timestamp || new Date().toISOString(),
      attachments: [],
      rawEventType: 'INTERACTION_CREATE',
      replyTarget: {
        scope: isGroup ? 'group' : 'c2c',
        targetId,
        // Use source msgId when platform provides it; otherwise proactive-only.
        msgId: sourceMsgId || undefined,
      },
    };

    // Route as normal message (commands + codex).
    await this.#onMessage(msg);
  }

  async #onMessage(msg) {
    // Dedup gateway redeliveries only after we know this id was already handled.
    if (msg?.messageId && this.deduper.has(msg.messageId)) {
      log.info(`dedup skip messageId=${msg.messageId}`);
      return;
    }
    const markHandled = () => {
      if (msg?.messageId) this.deduper.mark(msg.messageId);
    };

    // Guild / channel AT messages: synthesize a reply target via channel API.
    if ((msg.kind === 'guild' || msg.kind === 'dm') && !msg.replyTarget) {
      if (!this.config.bot.guildEnabled) {
        log.info('skip guild/dm (GUILD_ENABLED=false)');
        return;
      }
      msg.replyTarget = {
        scope: msg.kind === 'dm' ? 'dm' : 'guild',
        targetId: msg.kind === 'dm' ? (msg.guildId || '') : (msg.channelId || ''),
        msgId: msg.messageId,
        channelId: msg.channelId,
        guildId: msg.guildId,
      };
    }

    if (!msg?.replyTarget) {
      log.warn('skip message without replyTarget', { kind: msg.kind, messageId: msg.messageId });
      return;
    }

    if (!this.#allowed(msg)) {
      log.info('denied sender', msg.senderId);
      await this.#safeSendText(msg.replyTarget, '你不在白名单中。请联系管理员添加 openid。发送 /me 获取 openid。');
      markHandled();
      return;
    }

    // Group: only respond when @bot if requireMention=true.
    // Official group bot events are often GROUP_AT_MESSAGE_CREATE already.
    if (
      msg.kind === 'group'
      && this.config.qq.requireMention
      && msg.rawEventType === 'GROUP_MESSAGE_CREATE'
      && !this.#groupMentionsBot(msg)
    ) {
      log.info('skip group message without mention');
      return;
    }

    let text = stripMentions(msg.content || '');
    if (!text && msg.content) text = String(msg.content).trim();

    const quoted = extractQuotedText(msg);
    if (quoted) {
      text = text
        ? `${text}\n\n【引用消息】\n${quoted}`
        : `【引用消息】\n${quoted}`;
    }

    const hasAtt = Boolean((msg.attachments || []).length);
    if (!text && !hasAtt) {
      await this.#safeSendText(msg.replyTarget, '收到空消息。请发送文字/图片，或使用 /help', {
        keyboard: this.config.bot.keyboardEnabled ? commandKeyboard() : null,
        peer: this.#peer(msg),
      });
      markHandled();
      return;
    }

    const replyPeer = this.#peer(msg);
    const peer = this.#sessionPeer(msg, replyPeer);
    const queueKey = this.#peerKey(peer);
    const cmd = parseCommand(text);

    // Mark as accepted before work so gateway redeliveries during a long Codex
    // turn do not double-run. In-memory only: process restart still allows retry.
    markHandled();

    // Local bot commands must never wait behind a long Codex turn.
    if (cmd) {
      const handled = await this.#handleCommand(cmd, msg, peer);
      if (handled) {
        log.info(`command handled immediately ${queueKey}: /${cmd.name}`);
        return;
      }
    }

    msg._queuedAt = Date.now();
    log.info(`enqueue ${queueKey}: ${(text || '(media)').slice(0, 120)}`);
    if (msg.kind === 'group') {
      const waiting = this.queue.isActive(queueKey) || this.queue.pendingCount(queueKey) > 0;
      try {
        await this.#safeSendText(
          msg.replyTarget,
          waiting ? '⏳ 已收到，前面还有任务，完成后处理…' : '⏳ 已收到，开始处理…',
          { peer: replyPeer },
        );
      } catch (err) {
        log.warn('group acknowledgement failed', err?.message || err);
      }
    }
    try {
      await this.queue.add(queueKey, async () => {
        await this.#runCodexAndReply(msg, peer, text, replyPeer);
      });
    } catch (err) {
      // Soft-cancel from /stop while still queued — do not surface as failure.
      if (/用户取消|cancelled|aborted|任务已取消/i.test(String(err?.message || err))) {
        log.info(`queue cancelled ${queueKey}: ${err.message || err}`);
        return;
      }
      throw err;
    }
  }

  async #handleCommand(cmd, msg, peer) {
    const kb = this.config.bot.keyboardEnabled;

    // Full guild/channel management command set.
    if (isGuildCommand(cmd.name)) {
      const send = async (text) => this.#safeSendText(msg.replyTarget, text, { peer });
      return handleGuildCommand(cmd, {
        guildApi: this.guildApi || new GuildApi(this.bot.api),
        bot: this.bot,
        send,
        msg,
        peer,
        config: this.config,
      });
    }

    switch (cmd.name) {
      case 'ping':
      case 'bot-ping':
        await this.#safeSendText(msg.replyTarget, 'pong', { peer });
        return true;
      case 'help':
      case 'bot-help':
        await this.#safeSendText(msg.replyTarget, [
          `${this.config.bot.name} QQ Bot (Codex CLI)`,
          '普通消息会转发给 codex exec / resume。',
          '支持图片/语音/文件入站；Codex 产出的本地图片/文件可回传。',
          '命令:',
          '/help - 帮助（含快捷按钮）',
          '/ping - 探活',
          '/me - 查看 openid',
          '/new 或 /reset - 开启新 Codex 会话',
          '/status - 当前会话状态',
          '/cd <路径> - 设置该会话工作目录',
          '模型配置跟随本机 Codex CLI，不在 QQ 侧单独覆盖',
          '/serve <目录> [端口] - 启动持久静态网站（不随回复结束退出）',
          '/services - 查看持久服务',
          '/stop-serve <端口|id> - 停止持久服务',
          '/recall [id] - 撤回最近一条机器人消息',
          '/wakeup <文本> - C2C 主动唤醒消息（30 天窗口）',
          '/stop 或 /cancel - 取消当前/排队中的 Codex 任务',
          '/queue - 查看本会话队列与活跃任务',
          '/whoami - 同 /me',
          '/kb - 显示快捷按钮',
          '/g-help - 频道功能完整命令（管理/成员/身份组/禁言/公告/精华/日程/表态/私信等）',
        ].join('\n'), {
          keyboard: kb ? commandKeyboard() : null,
          peer,
        });
        return true;
      case 'kb':
      case 'menu':
      case 'buttons':
        await this.#safeSendText(msg.replyTarget, '快捷操作：', {
          keyboard: kb ? commandKeyboard() : null,
          peer,
        });
        return true;
      case 'me':
      case 'bot-me':
        await this.#safeSendText(msg.replyTarget, [
          `sender openid: ${msg.senderId}`,
          peer.kind === 'group' ? `group openid: ${peer.id}` : null,
          `kind: ${msg.kind}`,
        ].filter(Boolean).join('\n'), { peer });
        return true;
      case 'new':
      case 'reset':
      case 'clear':
        this.sessions.clearSession(peer.kind, peer.id);
        await this.#safeSendText(msg.replyTarget, '已开启新的 Codex 会话。', {
          keyboard: kb ? commandKeyboard() : null,
          peer,
        });
        return true;
      case 'status': {
        const st = this.sessions.get(peer.kind, peer.id) || {};
        const q = this.queue.stats();
        const job = this.activeJobs.get(this.#peerKey(peer));
        await this.#safeSendText(msg.replyTarget, [
          `peer: ${peer.kind}:${peer.id}`,
          `session: ${st.sessionId || '(none)'}`,
          `workdir: ${st.workdir || this.config.codex.workdir}`,
          'model: follow Codex CLI',
          `updated: ${st.updatedAt || '-'}`,
          `stream: ${this.config.bot.streamEnabled ? 'on' : 'off'}`,
          `media: ${this.config.bot.mediaEnabled ? 'on' : 'off'}`,
          `keyboard: ${this.config.bot.keyboardEnabled ? 'on' : 'off'}`,
          `markdown: ${this.config.bot.markdownEnabled ? 'on' : 'off'}`,
          `guild: ${this.config.bot.guildEnabled ? 'on' : 'off'}`,
          `queue: active=${q.active} pending=${q.pending}`,
          `thisJob: ${job ? 'running' : 'idle'}`,
        ].join('\n'), { peer });
        return true;
      }
      case 'cd': {
        if (!cmd.args) {
          await this.#safeSendText(msg.replyTarget, '用法: /cd /path/to/workdir', { peer });
          return true;
        }
        this.sessions.set(peer.kind, peer.id, { workdir: cmd.args });
        await this.#safeSendText(msg.replyTarget, `工作目录已设置: ${cmd.args}`, { peer });
        return true;
      }
      case 'model': {
        await this.#safeSendText(
          msg.replyTarget,
          '模型配置跟随本机 Codex CLI。请在终端切换 Codex 模型后，QQ 机器人下一次执行会自动使用新配置。',
          { peer },
        );
        return true;
      }
      case 'serve':
      case 'http-serve':
      case 'start-serve': {
        const parts = (cmd.args || '').split(/\s+/).filter(Boolean);
        if (!parts.length) {
          await this.#safeSendText(
            msg.replyTarget,
            '用法: /serve <目录> [端口]\n示例: /serve /storage/emulated/0/ZeroTermux/开发/cyberpunk-blog 9901',
            { peer },
          );
          return true;
        }
        const dir = parts[0];
        const port = parts[1] ? Number(parts[1]) : 8000;
        try {
          const rec = await this.services.startStatic({ rootDir: dir, port });
          const lan = detectLanIp();
          await this.#safeSendText(msg.replyTarget, [
            rec.reused ? '服务已在运行（复用）' : '持久服务已启动',
            `id: ${rec.id}`,
            `dir: ${rec.rootDir}`,
            `port: ${rec.port}`,
            `pid: ${rec.pid || '(external)'}`,
            `本机: http://127.0.0.1:${rec.port}/`,
            lan ? `局域网: http://${lan}:${rec.port}/` : null,
            '说明: 该服务由机器人进程托管，不会在 Codex 回复结束后被回收。',
          ].filter(Boolean).join('\n'), {
            keyboard: kb ? servicesKeyboard(this.services.list()) : null,
            peer,
          });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `启动失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'services':
      case 'svc':
      case 'ps-serve': {
        const lan = detectLanIp();
        await this.#safeSendText(msg.replyTarget, this.services.formatStatus(lan), {
          keyboard: kb ? servicesKeyboard(this.services.list()) : null,
          peer,
        });
        return true;
      }
      case 'stop-serve':
      case 'serve-stop': {
        if (!cmd.args) {
          await this.#safeSendText(msg.replyTarget, '用法: /stop-serve <端口|id>', { peer });
          return true;
        }
        try {
          const s = await this.services.stop(cmd.args.trim());
          await this.#safeSendText(msg.replyTarget, `已停止服务 ${s.id} (port ${s.port})`, {
            keyboard: kb ? servicesKeyboard(this.services.list()) : null,
            peer,
          });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `停止失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'recall':
      case '撤回': {
        const id = (cmd.args || '').trim() || this.#lastSentId(peer);
        if (!id) {
          await this.#safeSendText(msg.replyTarget, '没有可撤回的消息。用法: /recall [messageId]', { peer });
          return true;
        }
        try {
          await this.bot.recallMessage(msg.replyTarget, id);
          await this.#safeSendText(msg.replyTarget, `已撤回: ${id}`, { peer });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `撤回失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'wakeup':
      case 'wake': {
        if (peer.kind !== 'c2c') {
          await this.#safeSendText(msg.replyTarget, 'wakeup 仅支持私聊 C2C。', { peer });
          return true;
        }
        const content = (cmd.args || '').trim() || '你有一条来自 Codex 的提醒';
        try {
          await this.bot.sendWakeup({ scope: 'c2c', targetId: peer.id }, content);
          await this.#safeSendText(msg.replyTarget, '已发送 wakeup。', { peer });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `wakeup 失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'send-image':
      case 'image': {
        if (!cmd.args) {
          await this.#safeSendText(msg.replyTarget, '用法: /send-image /path/to.png', { peer });
          return true;
        }
        try {
          await this.#sendLocalMedia(msg.replyTarget, cmd.args.trim(), 'image');
          await this.#safeSendText(msg.replyTarget, '图片已发送。', { peer });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `发图失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'send-file':
      case 'file': {
        if (!cmd.args) {
          await this.#safeSendText(msg.replyTarget, '用法: /send-file /path/to/file', { peer });
          return true;
        }
        try {
          await this.#sendLocalMedia(msg.replyTarget, cmd.args.trim(), 'file');
          await this.#safeSendText(msg.replyTarget, '文件已发送。', { peer });
        } catch (err) {
          await this.#safeSendText(msg.replyTarget, `发文件失败: ${err.message || err}`, { peer });
        }
        return true;
      }
      case 'stop':
      case 'cancel':
      case 'abort': {
        const key = this.#peerKey(peer);
        const dropped = this.queue.cancelPending(key, '用户取消');
        const job = this.activeJobs.get(key);
        if (job?.controller) {
          try { job.controller.abort(); } catch {}
        }
        const active = Boolean(job);
        await this.#safeSendText(
          msg.replyTarget,
          active || dropped
            ? `已取消：活跃任务=${active ? '是' : '否'}，丢弃排队=${dropped}`
            : '当前没有可取消的任务。',
          { peer },
        );
        return true;
      }
      case 'queue':
      case 'jobs': {
        const key = this.#peerKey(peer);
        const st = this.queue.stats();
        const job = this.activeJobs.get(key);
        await this.#safeSendText(msg.replyTarget, [
          `peer: ${key}`,
          `本会话排队: ${this.queue.pendingCount(key)}`,
          `本会话活跃: ${this.queue.isActive(key) ? 'yes' : 'no'}`,
          job ? `活跃任务开始: ${new Date(job.startedAt).toISOString()}` : '活跃任务: (none)',
          job?.prompt ? `prompt: ${String(job.prompt).slice(0, 80)}` : null,
          `全局 active=${st.active} pending=${st.pending}`,
        ].filter(Boolean).join('\n'), { peer });
        return true;
      }
      case 'whoami':
        // alias
        await this.#safeSendText(msg.replyTarget, [
          `sender openid: ${msg.senderId}`,
          peer.kind === 'group' ? `group openid: ${peer.id}` : null,
          peer.kind === 'guild' ? `channel: ${msg.channelId || peer.id}` : null,
          `kind: ${msg.kind}`,
        ].filter(Boolean).join('\n'), { peer });
        return true;
      default:
        return false;
    }
  }

  async #sendLocalMedia(target, localPath, kindHint) {
    const p = path.resolve(localPath);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error(`文件不存在: ${p}`);
    }
    const kind = kindHint || mediaKindFromContentType('', p);
    // Guild/channel/dm targets are not ReplyTarget-shaped for media APIs.
    // Fall back to text path notice so Codex path answers still surface.
    if (target?.scope === 'guild' || target?.scope === 'channel' || target?.scope === 'dm') {
      const note = `[媒体] ${kind}: ${p}`;
      await this.#safeSendText(target, note);
      return { ok: true, fallback: 'text-path', path: p, kind };
    }
    if (kind === 'image') return this.bot.sendImage(target, { localPath: p });
    if (kind === 'video') return this.bot.sendVideo(target, { localPath: p });
    if (kind === 'voice') return this.bot.sendVoice(target, { localPath: p });
    return this.bot.sendFile(target, { localPath: p, fileName: path.basename(p) });
  }

  async #sendOutboundMedia(target, items = []) {
    if (!this.config.bot.mediaSendEnabled) return [];
    const results = [];
    for (const item of items.slice(0, this.config.bot.mediaMaxOutbound)) {
      try {
        const r = await this.#sendLocalMedia(target, item.localPath, item.kind);
        results.push({ ok: true, path: item.localPath, kind: item.kind });
        log.info(`sent outbound ${item.kind}: ${item.localPath}`);
      } catch (err) {
        results.push({ ok: false, path: item.localPath, error: err.message || String(err) });
        log.warn(`outbound media failed ${item.localPath}`, err?.message || err);
      }
    }
    return results;
  }

  async #runCodexAndReply(msg, peer, text, replyPeer = this.#peer(msg)) {
    const st = this.sessions.get(peer.kind, peer.id) || {};
    const workdir = st.workdir || this.config.codex.workdir;
    const sessionId = st.sessionId || null;
    const startedAt = Date.now();
    const queueWaitMs = Number(msg._queuedAt ? Date.now() - msg._queuedAt : 0);
    const peerKey = this.#peerKey(peer);
    const controller = new AbortController();
    this.activeJobs.set(peerKey, {
      controller,
      startedAt,
      prompt: (text || '').slice(0, 200),
    });
    const canStream =
      this.config.bot.streamEnabled
      && msg.replyTarget?.scope === 'c2c'
      && Boolean(msg.replyTarget?.msgId || msg.messageId);

    // Download inbound attachments before spawning codex.
    let downloaded = [];
    if (this.config.bot.mediaEnabled && (msg.attachments || []).length) {
      try {
        downloaded = await downloadAttachments(
          msg.attachments,
          this.config.paths.mediaDir,
          { timeoutMs: this.config.bot.mediaDownloadTimeoutMs },
        );
      } catch (err) {
        log.warn('attachment download batch failed', err?.message || err);
      }
    }
    // Also download quote attachments if any.
    const quoteAtts = [];
    for (const el of (msg.msgElements || [])) {
      if (Array.isArray(el?.attachments)) quoteAtts.push(...el.attachments);
    }
    if (this.config.bot.mediaEnabled && quoteAtts.length) {
      try {
        const more = await downloadAttachments(
          quoteAtts,
          this.config.paths.mediaDir,
          { timeoutMs: this.config.bot.mediaDownloadTimeoutMs },
        );
        downloaded = downloaded.concat(more);
      } catch {}
    }

    const imagePaths = downloaded
      .filter((d) => d.kind === 'image' && d.localPath)
      .map((d) => d.localPath);

    const runner = new CodexRunner({
      ...this.config,
      codex: {
        ...this.config.codex,
        workdir,
      },
    });

    let typingTimer = null;
    let groupStatusTimers = [];
    let stream = null;
    let streamOpened = false;
    let streamAlive = false;
    let streamCompleted = false;
    let streamText = ''; // QQ stream is append-only: new frames must keep old prefix
    const typingSec = Math.min(this.config.bot.typingIntervalSec, 10);

    const stopTyping = async () => {
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = null;
      }
      if (msg.replyTarget.scope === 'c2c' && msg.replyTarget.msgId) {
        try { await this.bot.sendTyping(msg.replyTarget, 1); } catch {}
      }
    };

    const startTyping = async () => {
      // QQ only supports typing notifications for C2C. Group acknowledgement
      // is sent before queueing so queued messages are visible immediately.
      if (msg.kind === 'group') {
        // Groups do not support stream_messages. One low-frequency status
        // update is enough to show that a long Codex turn is still alive.
        const delay = 90_000;
        groupStatusTimers.push(setTimeout(() => {
          this.#safeSendText(
            msg.replyTarget,
            '⏳ 任务仍在执行中（已约 1 分钟），完成后发送结果。',
            { peer: replyPeer },
          ).catch((err) => log.warn('group status update failed', err?.message || err));
        }, delay));
        return;
      }
      if (msg.replyTarget.scope !== 'c2c' || !msg.replyTarget.msgId) {
        log.info(`skip progress bubble for scope=${msg.replyTarget.scope}`);
        return;
      }
      try { await this.bot.sendTyping(msg.replyTarget, typingSec); } catch (e) {
        log.warn('sendTyping failed', e);
      }
      typingTimer = setInterval(() => {
        this.bot.sendTyping(msg.replyTarget, typingSec).catch(() => {});
      }, Math.max(4, typingSec - 1) * 1000);

    };

    const processBudget = Math.max(200, Math.min(900, Number(this.config.bot.streamProcessMaxChars || 700)));
    const processOnlyText = (raw) => {
      let s = String(raw || '').trim();
      if (!s) return '';
      const markers = ['\n\n**回复**', '\n**回复**', '**回复**'];
      for (const m of markers) {
        const i = s.indexOf(m);
        if (i >= 0) {
          s = s.slice(0, i).trimEnd();
          break;
        }
      }
      return s;
    };

    const normalizeStreamBody = (raw, { allowAnswer = true } = {}) => {
      let next = String(raw || '').trim();
      if (!next) return streamText;
      if (this.config.bot.replyPrefix && !next.startsWith(this.config.bot.replyPrefix)) {
        next = `${this.config.bot.replyPrefix}${next}`;
      }

      if (!streamText) {
        if (next.length > processBudget && next.includes('**回复**')) {
          return next.slice(0, this.config.bot.maxReplyChars);
        }
        if (next.length > processBudget) {
          return `${next.slice(0, processBudget - 10)}\n…`;
        }
        return next;
      }
      if (next === streamText) return streamText;
      if (next.startsWith(streamText)) {
        if (next.length > this.config.bot.maxReplyChars) return streamText;
        return next;
      }

      if (!allowAnswer) return streamText;
      const marker = '**回复**';
      if (next.includes(marker)) {
        const ans = next.split(marker).slice(1).join(marker).trim();
        if (ans && !streamText.includes(ans.slice(0, Math.min(40, ans.length)))) {
          const add = `\n\n**回复**\n${ans}`;
          const candidate = `${streamText}${add}`;
          if (candidate.length <= this.config.bot.maxReplyChars) return candidate;
        }
      }
      return streamText;
    };

    const killStream = (reason) => {
      if (!stream) return;
      streamAlive = false;
      try { stream.cancel(); } catch {}
      stream = null;
      if (reason) log.warn(`stream abandoned: ${reason}`);
    };

    const pushStream = async (raw, { done = false } = {}) => {
      if (!stream || !streamAlive) return false;
      const body = normalizeStreamBody(raw, { allowAnswer: true });
      if (!body) return false;
      try {
        if (body !== streamText) {
          await stream.update(body);
          streamText = body;
        }
        if (done) {
          await stream.complete();
          streamCompleted = true;
          streamAlive = false;
        }
        return true;
      } catch (err) {
        log.warn('stream push failed', err?.message || err);
        killStream(err?.message || 'push failed');
        return false;
      }
    };

    const sendFinalAnswer = async (answer) => {
      await this.#safeSendChunks(msg.replyTarget, answer || '(空响应)', { peer });
    };

    await startTyping();

    try {
      log.info('codex start', {
        peer,
        sessionId,
        workdir,
        queueWaitMs,
        stream: canStream,
        images: imagePaths.length,
        attachments: downloaded.length,
        text: (text || '').slice(0, 120),
      });
      const prompt = this.#buildPrompt(msg, text, downloaded);

      const onPartial = canStream
        ? async ({ text: partial }) => {
            const body = String(partial || '').trim();
            if (!body || body === 'Codex 处理中…' || body === 'Codex 处理中...') return;

            if (!streamOpened) {
              try {
                const target = {
                  ...msg.replyTarget,
                  msgId: msg.replyTarget.msgId || msg.messageId,
                };
                stream = this.bot.openStream({
                  target,
                  throttleMs: this.config.bot.streamThrottleMs,
                });
                streamOpened = true;
                streamAlive = true;
                log.info('c2c stream opened on first partial');
                await stopTyping();
              } catch (err) {
                log.warn('openStream failed, stay on sendText', err?.message || err);
                stream = null;
                streamAlive = false;
                return;
              }
            }
            await pushStream(processOnlyText(body) || body, { done: false });
          }
        : null;

      const result = await runner.run({
        prompt,
        sessionId,
        images: imagePaths,
        onPartial,
        signal: controller.signal,
        timeoutMs: msg.kind === 'group'
          ? this.config.codex.groupTimeoutMs
          : this.config.codex.timeoutMs,
      });
      if (result.sessionId) {
        this.sessions.set(peer.kind, peer.id, {
          sessionId: result.sessionId,
          workdir,
          lastPrompt: (text || '').slice(0, 200),
        });
      }

      let reply = result.text || '(空响应)';
      let streamReply = (this.config.bot.streamThinking && result.streamText) ? result.streamText : reply;
      if (this.config.bot.replyPrefix) {
        if (!reply.startsWith(this.config.bot.replyPrefix)) reply = `${this.config.bot.replyPrefix}${reply}`;
        if (!streamReply.startsWith(this.config.bot.replyPrefix)) streamReply = `${this.config.bot.replyPrefix}${streamReply}`;
      }
      const codexMs = Date.now() - startedAt;
      log.info(`codex done, streamAlive=${streamAlive}, streamTextChars=${streamText.length}, session=${result.sessionId}, codexMs=${codexMs}, queueWaitMs=${queueWaitMs}, chars=${reply.length}, processSteps=${(result.processLog || []).length}`);

      if (streamAlive) {
        await pushStream(processOnlyText(streamReply) || processOnlyText(streamText) || streamText, { done: true });
      } else if (stream && !streamCompleted) {
        killStream('before final sendText');
      }

      await stopTyping();
      await sendFinalAnswer(reply);

      // Outbound media discovered from Codex answer paths.
      try {
        const mediaItems = extractOutboundMedia(reply, { max: this.config.bot.mediaMaxOutbound });
        if (mediaItems.length) {
          let outbound = mediaItems;
          if (msg.kind === 'group' && mediaItems.length > 1) {
            try {
              const archive = createZipArchive(mediaItems, path.join(this.config.paths.mediaDir, 'outbound'));
              if (archive) {
                outbound = [{ kind: 'file', localPath: archive, filename: path.basename(archive) }];
                log.info(`packed ${mediaItems.length} group files: ${archive}`);
              }
            } catch (err) {
              log.warn('group media zip failed', err?.message || err);
            }
          }
          const sent = await this.#sendOutboundMedia(msg.replyTarget, outbound);
          const failed = sent.filter((x) => !x.ok);
          if (failed.length) {
            await this.#safeSendText(
              msg.replyTarget,
              `部分媒体发送失败:\n${failed.map((f) => `- ${f.path}: ${f.error}`).join('\n')}`,
              { peer },
            );
          }
        }
      } catch (err) {
        log.warn('outbound media scan failed', err?.message || err);
      }
      return;
    } catch (err) {
      await stopTyping();
      const cancelled = controller.signal.aborted || /任务已取消|用户取消|cancelled|aborted/i.test(String(err?.message || err));
      if (cancelled) {
        if (streamAlive) {
          await pushStream('已取消。', { done: true });
        } else {
          try { await this.#safeSendText(msg.replyTarget, '已取消当前任务。', { peer }); } catch {}
        }
        return;
      }
      if (streamAlive) {
        const msgText = `处理失败: ${err.message || err}`;
        const ok = await pushStream(msgText, { done: true });
        if (ok) return;
      }
      if (stream && !streamCompleted) killStream('error fallback');
      throw err;
    } finally {
      for (const timer of groupStatusTimers) clearTimeout(timer);
      await stopTyping();
      if (stream && !streamCompleted && streamAlive) {
        try { await stream.complete(); streamCompleted = true; } catch { killStream('finally'); }
      } else if (stream && !streamCompleted) {
        killStream('finally');
      }
      const cur = this.activeJobs.get(peerKey);
      if (cur?.controller === controller) this.activeJobs.delete(peerKey);
    }
  }

  #buildPrompt(msg, text, downloaded = []) {
    const peer = this.#peer(msg);
    const groupActors = this.#groupActors(msg, peer);
    const lines = [
      `你是 ${this.config.bot.name}，正在通过 QQ 与用户协作。`,
      '请直接给出可执行结论；代码用 fenced code block。',
      `通道: ${msg.kind}`,
      `用户 openid: ${msg.senderId}`,
      '',
      '【持久服务硬性规则 — 必须遵守】',
      '1) 启动网站/HTTP 服务时，禁止只用前台命令：',
      '   禁止: python3 -m http.server / python3 serve*.py / npx serve 直接前台跑',
      '   原因: codex exec 回合结束后会回收该进程树，服务会立刻挂掉。',
      '2) 必须用下面任一持久化方式：',
      `   A) 推荐脚本: python3 ${path.join(this.config.projectRoot, 'scripts/persist-http-server.py')} --root <站点目录> --port <端口>`,
      '   B) 告诉用户在 QQ 发送: /serve <站点目录> <端口>',
      '3) 启动后必须探测 HTTP 200，并同时给出：',
      '   - http://127.0.0.1:<port>/',
      '   - 局域网 IP（若可获取）',
      '   - file:// 本地文件兜底路径（静态站）',
      '4) 不要声称“已启动”除非探测成功；若只能前台启动，必须明确警告会随回合结束退出。',
      '',
      '【媒体回传】若你生成了图片/截图/文件并希望用户在 QQ 看到，请在回复中写出本地绝对路径',
      '（例如 /tmp/foo.png 或 file:///tmp/foo.png），机器人会自动发送给用户。',
    ];
    if (msg.kind === 'group') {
      lines.push(`群 openid: ${msg.groupOpenid || ''}`);
      lines.push('', '【群聊人物 ID】');
      lines.push('人物 ID 按群内成员稳定分配，仅用于区分说话人，不代表真实姓名。');
      if (groupActors?.sender) {
        lines.push(`本条发言者: ${groupActors.sender.id}${groupActors.sender.name ? `（${groupActors.sender.name}）` : ''}`);
      }
      if (groupActors?.mentioned?.length) {
        lines.push(`本条 @ 的成员: ${groupActors.mentioned.map((memberId) => {
          const actor = groupActors.actors[memberId];
          return `${actor.id}${actor.name ? `（${actor.name}）` : ''}`;
        }).join('、')}`);
      } else {
        lines.push('本条没有 @ 其他群成员。');
      }
      lines.push('完整群成员映射:');
      for (const actor of Object.values(groupActors?.actors || {})) {
        lines.push(`- ${actor.id}${actor.name ? `（${actor.name}）` : ''}`);
      }
    }

    const attLines = formatAttachmentPrompt(downloaded);
    if (attLines.length) lines.push('', ...attLines);

    try {
      const lan = detectLanIp();
      const svcs = this.services.list().filter((s) => s.alive);
      if (svcs.length) {
        lines.push('', '【当前机器人托管的持久服务】');
        for (const s of svcs) {
          lines.push(`- ${s.id} port=${s.port} dir=${s.rootDir} url=http://127.0.0.1:${s.port}/${lan ? ` 或 http://${lan}:${s.port}/` : ''}`);
        }
      }
    } catch {}
    lines.push('', '用户消息:', text || (downloaded.length ? '(仅附件，无文本)' : '(无文本)'));
    return lines.join('\n');
  }
}
