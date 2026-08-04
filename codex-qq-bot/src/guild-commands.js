import {
  fmtChannel,
  fmtGuild,
  fmtList,
  fmtMember,
  fmtRole,
} from './guild-api.js';

/**
 * Handle /g-* and /guild-* style channel management commands.
 * @returns {Promise<boolean>} true if handled
 */
export async function handleGuildCommand(cmd, ctx) {
  const { guildApi, send, msg, peer, config } = ctx;
  if (!config.bot.guildEnabled) {
    await send('频道功能已关闭（GUILD_ENABLED=false）');
    return true;
  }

  const name = cmd.name;
  // Normalize aliases: g-channels / guild-channels / channels
  const n = name
    .replace(/^guild-/, 'g-')
    .replace(/^channel-/, 'g-');

  // Resolve default guild/channel from current message when possible.
  const defaultGuildId = msg.guildId || peer?.kind === 'guild' && msg.guildId || null;
  const defaultChannelId = msg.channelId || (peer?.kind === 'guild' ? peer.id : null);

  const args = splitArgs(cmd.args || '');
  const need = (k) => {
    throw new Error(`缺少参数: ${k}`);
  };

  try {
    switch (n) {
      case 'g':
      case 'g-help':
      case 'guild':
      case 'guild-help':
        await send(guildHelpText());
        return true;

      // ── me / guilds ──
      case 'g-me':
      case 'me-bot': {
        const me = await guildApi.me();
        await send([
          `bot: ${me.username || me.id}`,
          `id: ${me.id}`,
          me.bot ? '类型: bot' : null,
        ].filter(Boolean).join('\n'));
        return true;
      }
      case 'g-list':
      case 'g-guilds': {
        const list = await guildApi.meGuilds({ limit: 100 });
        const arr = Array.isArray(list) ? list : (list?.guilds || []);
        await send(fmtList(
          '我加入的频道',
          arr.map((g) => `${g.name} (${g.id})`),
        ));
        return true;
      }
      case 'g-info':
      case 'g-guild': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const g = await guildApi.guild(guildId);
        await send(fmtGuild(g));
        return true;
      }

      // ── channels ──
      case 'g-channels': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const list = await guildApi.channels(guildId);
        const arr = Array.isArray(list) ? list : [];
        await send(fmtList(
          `子频道列表 (${guildId})`,
          arr.map((c) => `${c.name} type=${c.type} id=${c.id}`),
        ));
        return true;
      }
      case 'g-channel': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const c = await guildApi.channel(channelId);
        await send(fmtChannel(c));
        return true;
      }
      case 'g-channel-create': {
        // /g-channel-create <guild_id> <name> [type]
        const guildId = args[0] || need('guild_id');
        const cname = args[1] || need('name');
        const type = args[2] != null ? Number(args[2]) : 0;
        const c = await guildApi.createChannel(guildId, { name: cname, type });
        await send(`已创建子频道\n${fmtChannel(c)}`);
        return true;
      }
      case 'g-channel-edit': {
        // /g-channel-edit <channel_id> <name>
        const channelId = args[0] || need('channel_id');
        const cname = args[1] || need('name');
        const c = await guildApi.patchChannel(channelId, { name: cname });
        await send(`已修改\n${fmtChannel(c)}`);
        return true;
      }
      case 'g-channel-del':
      case 'g-channel-delete': {
        const channelId = args[0] || need('channel_id');
        await guildApi.deleteChannel(channelId);
        await send(`已删除子频道 ${channelId}`);
        return true;
      }
      case 'g-voice-members': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const list = await guildApi.voiceMembers(channelId);
        const arr = Array.isArray(list) ? list : [];
        await send(fmtList(
          `语音成员 (${channelId})`,
          arr.map((m) => (m.user?.username || m.nick || m.user?.id || '?')),
        ));
        return true;
      }

      // ── members ──
      case 'g-members': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const after = args[1] || '0';
        const list = await guildApi.members(guildId, { after, limit: 50 });
        const arr = Array.isArray(list) ? list : [];
        await send(fmtList(
          `成员 (${guildId})`,
          arr.map((m) => `${m.user?.username || m.nick || '?'} id=${m.user?.id || '-'}`),
        ));
        return true;
      }
      case 'g-member': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const userId = args[1] || need('user_id');
        const m = await guildApi.member(guildId, userId);
        await send(fmtMember(m));
        return true;
      }
      case 'g-kick': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const userId = args[1] || need('user_id');
        const blacklist = args[2] === '1' || args[2] === 'true';
        await guildApi.kickMember(guildId, userId, {
          add_blacklist: blacklist,
          delete_history_msg_days: 0,
        });
        await send(`已踢出 ${userId}${blacklist ? '（并拉黑）' : ''}`);
        return true;
      }

      // ── roles ──
      case 'g-roles': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const res = await guildApi.roles(guildId);
        const roles = res?.roles || res || [];
        const arr = Array.isArray(roles) ? roles : [];
        await send(fmtList(`身份组 (${guildId})`, arr.map(fmtRole)));
        return true;
      }
      case 'g-role-create': {
        const guildId = args[0] || need('guild_id');
        const rname = args[1] || need('name');
        const color = args[2] != null ? Number(args[2]) : 4286945;
        const res = await guildApi.createRole(guildId, { name: rname, color, hoist: 0 });
        await send(`已创建身份组\n${JSON.stringify(res).slice(0, 500)}`);
        return true;
      }
      case 'g-role-edit': {
        const guildId = args[0] || need('guild_id');
        const roleId = args[1] || need('role_id');
        const rname = args[2] || need('name');
        const res = await guildApi.patchRole(guildId, roleId, { name: rname });
        await send(`已修改身份组\n${JSON.stringify(res).slice(0, 500)}`);
        return true;
      }
      case 'g-role-del':
      case 'g-role-delete': {
        const guildId = args[0] || need('guild_id');
        const roleId = args[1] || need('role_id');
        await guildApi.deleteRole(guildId, roleId);
        await send(`已删除身份组 ${roleId}`);
        return true;
      }
      case 'g-role-add': {
        // /g-role-add <guild> <user> <role>
        const guildId = args[0] || need('guild_id');
        const userId = args[1] || need('user_id');
        const roleId = args[2] || need('role_id');
        await guildApi.addMemberRole(guildId, userId, roleId, {});
        await send(`已为 ${userId} 添加角色 ${roleId}`);
        return true;
      }
      case 'g-role-rm':
      case 'g-role-remove': {
        const guildId = args[0] || need('guild_id');
        const userId = args[1] || need('user_id');
        const roleId = args[2] || need('role_id');
        await guildApi.removeMemberRole(guildId, userId, roleId, {});
        await send(`已移除 ${userId} 的角色 ${roleId}`);
        return true;
      }
      case 'g-role-members': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const roleId = args[1] || need('role_id');
        const { members, next } = await (async () => {
          const r = await guildApi.roleMembers(guildId, roleId, { limit: 50 });
          // API may return array or {data,next}
          if (Array.isArray(r)) return { members: r, next: '' };
          return { members: r?.data || r?.members || [], next: r?.next || '' };
        })();
        await send(fmtList(
          `角色成员 role=${roleId}`,
          (members || []).map((m) => m.user?.username || m.user?.id || '?')
            .concat(next ? [`next=${next}`] : []),
        ));
        return true;
      }

      // ── permissions ──
      case 'g-perm':
      case 'g-perm-user': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const userId = args[1] || need('user_id');
        const p = await guildApi.channelUserPermissions(channelId, userId);
        await send(`子频道用户权限\n${JSON.stringify(p, null, 0).slice(0, 800)}`);
        return true;
      }
      case 'g-perm-user-set': {
        // /g-perm-user-set <channel> <user> <add> <remove>
        const channelId = args[0] || need('channel_id');
        const userId = args[1] || need('user_id');
        const add = args[2] || '0';
        const remove = args[3] || '0';
        await guildApi.putChannelUserPermissions(channelId, userId, { add, remove });
        await send(`已更新用户权限 channel=${channelId} user=${userId}`);
        return true;
      }
      case 'g-perm-role': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const roleId = args[1] || need('role_id');
        const p = await guildApi.channelRolePermissions(channelId, roleId);
        await send(`子频道身份组权限\n${JSON.stringify(p, null, 0).slice(0, 800)}`);
        return true;
      }
      case 'g-perm-role-set': {
        const channelId = args[0] || need('channel_id');
        const roleId = args[1] || need('role_id');
        const add = args[2] || '0';
        const remove = args[3] || '0';
        await guildApi.putChannelRolePermissions(channelId, roleId, { add, remove });
        await send(`已更新身份组权限 channel=${channelId} role=${roleId}`);
        return true;
      }

      // ── mute ──
      case 'g-mute': {
        // /g-mute <guild> <seconds>  (whole guild)
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const seconds = String(args[1] || need('seconds'));
        await guildApi.guildMute(guildId, { mute_seconds: seconds });
        await send(seconds === '0' ? `已解除全员禁言 ${guildId}` : `已全员禁言 ${seconds}s`);
        return true;
      }
      case 'g-mute-user': {
        // /g-mute-user <guild> <user> <seconds>
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const userId = args[1] || need('user_id');
        const seconds = String(args[2] || need('seconds'));
        await guildApi.memberMute(guildId, userId, { mute_seconds: seconds });
        await send(seconds === '0' ? `已解除禁言 ${userId}` : `已禁言 ${userId} ${seconds}s`);
        return true;
      }
      case 'g-mute-users': {
        // /g-mute-users <guild> <seconds> <uid1,uid2,...>
        const guildId = args[0] || need('guild_id');
        const seconds = String(args[1] || need('seconds'));
        const uids = (args[2] || need('user_ids')).split(',').map((s) => s.trim()).filter(Boolean);
        await guildApi.guildMute(guildId, { mute_seconds: seconds, user_ids: uids });
        await send(`已批量禁言 ${uids.length} 人 ${seconds}s`);
        return true;
      }

      // ── announces ──
      case 'g-announce': {
        // channel announce: /g-announce <channel> <message_id>
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        const r = await guildApi.createChannelAnnounce(channelId, messageId);
        await send(`已设置子频道公告\n${JSON.stringify(r).slice(0, 400)}`);
        return true;
      }
      case 'g-announce-del': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || 'all';
        await guildApi.deleteChannelAnnounce(channelId, messageId);
        await send(`已删除子频道公告 ${messageId}`);
        return true;
      }
      case 'g-gannounce': {
        // guild global announce: /g-gannounce <guild> <channel> <message_id>
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const channelId = args[1] || defaultChannelId || need('channel_id');
        const messageId = args[2] || need('message_id');
        const r = await guildApi.createGuildAnnounce(guildId, { messageId, channelId });
        await send(`已设置频道全局公告\n${JSON.stringify(r).slice(0, 400)}`);
        return true;
      }
      case 'g-gannounce-del': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const messageId = args[1] || 'all';
        await guildApi.deleteGuildAnnounce(guildId, messageId);
        await send(`已删除频道全局公告 ${messageId}`);
        return true;
      }

      // ── pins ──
      case 'g-pins': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const r = await guildApi.pins(channelId);
        const ids = r?.message_ids || r?.messageIds || [];
        await send(fmtList(`精华消息 (${channelId})`, ids.length ? ids : [JSON.stringify(r).slice(0, 300)]));
        return true;
      }
      case 'g-pin': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        const r = await guildApi.addPin(channelId, messageId);
        await send(`已加精华 ${messageId}\n${JSON.stringify(r).slice(0, 300)}`);
        return true;
      }
      case 'g-unpin': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || 'all';
        await guildApi.deletePin(channelId, messageId);
        await send(`已取消精华 ${messageId}`);
        return true;
      }

      // ── schedules ──
      case 'g-schedules': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const since = args[1] ? Number(args[1]) : 0;
        const list = await guildApi.schedules(channelId, since);
        const arr = Array.isArray(list) ? list : [];
        await send(fmtList(
          `日程 (${channelId})`,
          arr.map((s) => `${s.name || s.id} start=${s.start_timestamp || s.start_time || '-'} id=${s.id}`),
        ));
        return true;
      }
      case 'g-schedule': {
        const channelId = args[0] || need('channel_id');
        const scheduleId = args[1] || need('schedule_id');
        const s = await guildApi.schedule(channelId, scheduleId);
        await send(JSON.stringify(s, null, 2).slice(0, 1500));
        return true;
      }
      case 'g-schedule-create': {
        // /g-schedule-create <channel> <name> <start_ts> <end_ts>
        const channelId = args[0] || need('channel_id');
        const sname = args[1] || need('name');
        const start = args[2] || need('start_timestamp');
        const end = args[3] || need('end_timestamp');
        const s = await guildApi.createSchedule(channelId, {
          name: sname,
          start_timestamp: String(start),
          end_timestamp: String(end),
        });
        await send(`已创建日程\n${JSON.stringify(s).slice(0, 500)}`);
        return true;
      }
      case 'g-schedule-del': {
        const channelId = args[0] || need('channel_id');
        const scheduleId = args[1] || need('schedule_id');
        await guildApi.deleteSchedule(channelId, scheduleId);
        await send(`已删除日程 ${scheduleId}`);
        return true;
      }

      // ── reactions ──
      case 'g-react': {
        // /g-react <channel> <message> <emoji_type> <emoji_id>
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        const emojiType = args[2] || '1';
        const emojiId = args[3] || need('emoji_id');
        await guildApi.addReaction(channelId, messageId, emojiType, emojiId);
        await send(`已表态 ${emojiType}:${emojiId}`);
        return true;
      }
      case 'g-unreact': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        const emojiType = args[2] || '1';
        const emojiId = args[3] || need('emoji_id');
        await guildApi.deleteOwnReaction(channelId, messageId, emojiType, emojiId);
        await send(`已取消表态 ${emojiType}:${emojiId}`);
        return true;
      }
      case 'g-react-users': {
        const channelId = args[0] || need('channel_id');
        const messageId = args[1] || need('message_id');
        const emojiType = args[2] || '1';
        const emojiId = args[3] || need('emoji_id');
        const r = await guildApi.reactionUsers(channelId, messageId, emojiType, emojiId, {
          cookie: '',
          limit: 50,
        });
        await send(JSON.stringify(r).slice(0, 1200));
        return true;
      }

      // ── messages ──
      case 'g-msg': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        const m = await guildApi.getMessage(channelId, messageId);
        await send(JSON.stringify(m, null, 2).slice(0, 1500));
        return true;
      }
      case 'g-msgs': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const limit = args[1] ? Number(args[1]) : 20;
        const list = await guildApi.getMessages(channelId, { limit });
        const arr = Array.isArray(list) ? list : (list?.messages || []);
        await send(fmtList(
          `最近消息 (${channelId})`,
          arr.map((m) => `${m.id}: ${(m.content || '').slice(0, 40)}`),
        ));
        return true;
      }
      case 'g-msg-del':
      case 'g-recall-channel': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const messageId = args[1] || need('message_id');
        await guildApi.deleteChannelMessage(channelId, messageId, true);
        await send(`已撤回频道消息 ${messageId}`);
        return true;
      }
      case 'g-say': {
        // /g-say <channel_id> <text...>
        const channelId = args[0] || defaultChannelId || need('channel_id');
        const text = (cmd.args || '').replace(args[0] || '', '').trim() || need('text');
        const r = await ctx.bot.sendChannelMessage(channelId, text, {
          msgId: msg.messageId,
        });
        await send(`已发送到频道 ${channelId}\nid=${r?.id || '-'}`);
        return true;
      }

      // ── dm ──
      case 'g-dm': {
        // /g-dm <recipient_id> <source_guild_id> <text...>
        const recipientId = args[0] || need('recipient_id');
        const sourceGuildId = args[1] || defaultGuildId || need('source_guild_id');
        const text = (cmd.args || '').split(/\s+/).slice(2).join(' ') || need('text');
        const dm = await guildApi.createDm(recipientId, sourceGuildId);
        const guildId = dm?.guild_id || dm?.id;
        if (!guildId) {
          await send(`创建私信失败: ${JSON.stringify(dm).slice(0, 300)}`);
          return true;
        }
        const r = await ctx.bot.sendDmMessage(guildId, text, {});
        await send(`已私信 ${recipientId}\ndm_guild=${guildId} msg=${r?.id || '-'}`);
        return true;
      }

      // ── audio / mic ──
      case 'g-mic-on': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        await guildApi.putMic(channelId);
        await send(`已上麦 ${channelId}`);
        return true;
      }
      case 'g-mic-off': {
        const channelId = args[0] || defaultChannelId || need('channel_id');
        await guildApi.deleteMic(channelId);
        await send(`已下麦 ${channelId}`);
        return true;
      }
      case 'g-audio': {
        // /g-audio <channel> <status>  status: 0开始 1暂停 2恢复 3停止
        const channelId = args[0] || need('channel_id');
        const status = Number(args[1] ?? 0);
        const audioUrl = args[2] || '';
        const body = { status };
        if (audioUrl) body.audio_url = audioUrl;
        if (args[3]) body.text = args[3];
        const r = await guildApi.postAudio(channelId, body);
        await send(`音频控制 status=${status}\n${JSON.stringify(r).slice(0, 300)}`);
        return true;
      }

      // ── api permissions ──
      case 'g-api-perm': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const r = await guildApi.apiPermissions(guildId);
        const apis = r?.apis || r || [];
        if (Array.isArray(apis)) {
          await send(fmtList(
            `API 权限 (${guildId})`,
            apis.map((a) => `${a.path || a.desc || JSON.stringify(a).slice(0, 60)} method=${a.method || ''}`),
            40,
          ));
        } else {
          await send(JSON.stringify(r).slice(0, 1500));
        }
        return true;
      }
      case 'g-api-demand': {
        // /g-api-demand <guild> <path> <method> [desc] [channel_id]
        const guildId = args[0] || need('guild_id');
        const path = args[1] || need('path');
        const method = args[2] || 'GET';
        const desc = args[3] || path;
        const channelId = args[4] || defaultChannelId;
        const body = {
          channel_id: channelId,
          api_identify: { path, method },
          desc,
        };
        const r = await guildApi.requireApiPermissions(guildId, body);
        await send(`已创建授权链接/需求\n${JSON.stringify(r).slice(0, 800)}`);
        return true;
      }
      case 'g-msg-setting': {
        const guildId = args[0] || defaultGuildId || need('guild_id');
        const r = await guildApi.messageSetting(guildId);
        await send(`消息频率设置\n${JSON.stringify(r).slice(0, 800)}`);
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    await send(`频道命令失败: ${err.message || err}`);
    return true;
  }
}

export function isGuildCommand(name) {
  if (!name) return false;
  if (name === 'g' || name === 'guild') return true;
  if (name.startsWith('g-') || name.startsWith('guild-') || name.startsWith('channel-')) return true;
  // also accept a few bare aliases
  return [
    'g-help', 'g-list', 'g-channels', 'g-members', 'g-roles',
  ].includes(name);
}

function splitArgs(s) {
  // keep simple whitespace split; quoted strings not required for IDs
  return String(s || '').trim().split(/\s+/).filter(Boolean);
}

export function guildHelpText() {
  return [
    '频道功能命令（需相应 API 权限）',
    '查询:',
    '  /g-help',
    '  /g-me',
    '  /g-list',
    '  /g-info [guild_id]',
    '  /g-channels [guild_id]',
    '  /g-channel [channel_id]',
    '  /g-members [guild_id] [after]',
    '  /g-member <guild> <user>',
    '  /g-roles [guild_id]',
    '  /g-role-members <guild> <role>',
    '  /g-msg-setting [guild]',
    '  /g-api-perm [guild]',
    '子频道管理:',
    '  /g-channel-create <guild> <name> [type]',
    '  /g-channel-edit <channel> <name>',
    '  /g-channel-del <channel>',
    '  /g-voice-members [channel]',
    '成员/身份组:',
    '  /g-kick <guild> <user> [blacklist]',
    '  /g-role-create <guild> <name> [color]',
    '  /g-role-edit <guild> <role> <name>',
    '  /g-role-del <guild> <role>',
    '  /g-role-add <guild> <user> <role>',
    '  /g-role-rm <guild> <user> <role>',
    '权限:',
    '  /g-perm-user <channel> <user>',
    '  /g-perm-user-set <channel> <user> <add> <remove>',
    '  /g-perm-role <channel> <role>',
    '  /g-perm-role-set <channel> <role> <add> <remove>',
    '禁言:',
    '  /g-mute <guild> <seconds>   (0=解除)',
    '  /g-mute-user <guild> <user> <seconds>',
    '  /g-mute-users <guild> <seconds> <uid1,uid2>',
    '公告/精华:',
    '  /g-announce <channel> <msg_id>',
    '  /g-announce-del <channel> [msg_id|all]',
    '  /g-gannounce <guild> <channel> <msg_id>',
    '  /g-gannounce-del <guild> [msg_id|all]',
    '  /g-pins [channel]',
    '  /g-pin <channel> <msg_id>',
    '  /g-unpin <channel> [msg_id|all]',
    '日程:',
    '  /g-schedules [channel] [since]',
    '  /g-schedule <channel> <schedule_id>',
    '  /g-schedule-create <channel> <name> <start_ts> <end_ts>',
    '  /g-schedule-del <channel> <schedule_id>',
    '消息/表态/私信:',
    '  /g-say <channel> <text>',
    '  /g-msg <channel> <msg_id>',
    '  /g-msgs [channel] [limit]',
    '  /g-msg-del <channel> <msg_id>',
    '  /g-react <channel> <msg> <emoji_type> <emoji_id>',
    '  /g-unreact <channel> <msg> <emoji_type> <emoji_id>',
    '  /g-dm <user> <source_guild> <text>',
    '音频:',
    '  /g-mic-on [channel]  /g-mic-off [channel]',
    '  /g-audio <channel> <status> [url] [text]',
    '授权:',
    '  /g-api-demand <guild> <path> <method> [desc] [channel]',
    '',
    '说明: 在频道内发命令时 guild_id/channel_id 可省略，默认取当前上下文。',
    'type: 0文字 2语音 4分组 10005直播 10006应用 10007论坛',
  ].join('\n');
}
