/**
 * QQ 频道（Guild）OpenAPI 封装。
 * 路径对齐官方 botgo openapi/v1 resource 定义，通过 QQBot.api 网关调用。
 *
 * 文档侧栏：频道管理 / 成员 / 身份组 / 发言管理 / 内容管理 / 接口授权
 * 具体 REST 路径来自 tencent-connect/botgo openapi/v1/resource.go
 */

export class GuildApi {
  /**
   * @param {{ get: Function, post: Function, put: Function, patch: Function, delete: Function }} api
   */
  constructor(api) {
    this.api = api;
  }

  // ── User ──
  me() {
    return this.api.get('/users/@me');
  }

  meGuilds(query = {}) {
    return this.api.get('/users/@me/guilds', query);
  }

  // ── Guild ──
  guild(guildId) {
    return this.api.get(`/guilds/${enc(guildId)}`);
  }

  // ── Channels ──
  channels(guildId) {
    return this.api.get(`/guilds/${enc(guildId)}/channels`);
  }

  channel(channelId) {
    return this.api.get(`/channels/${enc(channelId)}`);
  }

  createChannel(guildId, body) {
    return this.api.post(`/guilds/${enc(guildId)}/channels`, body);
  }

  patchChannel(channelId, body) {
    return this.api.patch(`/channels/${enc(channelId)}`, body);
  }

  deleteChannel(channelId) {
    return this.api.delete(`/channels/${enc(channelId)}`);
  }

  voiceMembers(channelId) {
    return this.api.get(`/channels/${enc(channelId)}/voice/members`);
  }

  // ── Members ──
  members(guildId, { after = '0', limit = 100 } = {}) {
    return this.api.get(`/guilds/${enc(guildId)}/members`, { after, limit });
  }

  member(guildId, userId) {
    return this.api.get(`/guilds/${enc(guildId)}/members/${enc(userId)}`);
  }

  roleMembers(guildId, roleId, { startIndex = '0', limit = 100 } = {}) {
    return this.api.get(`/guilds/${enc(guildId)}/roles/${enc(roleId)}/members`, {
      start_index: startIndex,
      limit,
    });
  }

  kickMember(guildId, userId, opts = {}) {
    // body: add_blacklist?, delete_history_msg_days?
    return this.apiRequest('DELETE', `/guilds/${enc(guildId)}/members/${enc(userId)}`, opts);
  }

  // ── Roles ──
  roles(guildId) {
    return this.api.get(`/guilds/${enc(guildId)}/roles`);
  }

  createRole(guildId, role) {
    const filter = { name: 1, color: 1, hoist: 1 };
    const info = {
      name: role.name,
      color: role.color ?? 4278245297,
      hoist: role.hoist ?? 0,
    };
    // botgo dto.UpdateRole json: { guild_id, filter, info }
    return this.api.post(`/guilds/${enc(guildId)}/roles`, {
      guild_id: guildId,
      filter,
      info,
    });
  }

  patchRole(guildId, roleId, role) {
    const info = {
      name: role.name,
      color: role.color ?? 4278245297,
      hoist: role.hoist ?? 0,
    };
    return this.api.patch(`/guilds/${enc(guildId)}/roles/${enc(roleId)}`, {
      guild_id: guildId,
      filter: { name: 1, color: 1, hoist: 1 },
      info,
    });
  }

  deleteRole(guildId, roleId) {
    return this.api.delete(`/guilds/${enc(guildId)}/roles/${enc(roleId)}`);
  }

  addMemberRole(guildId, userId, roleId, body = {}) {
    return this.api.put(
      `/guilds/${enc(guildId)}/members/${enc(userId)}/roles/${enc(roleId)}`,
      body,
    );
  }

  removeMemberRole(guildId, userId, roleId, body = {}) {
    return this.apiRequest(
      'DELETE',
      `/guilds/${enc(guildId)}/members/${enc(userId)}/roles/${enc(roleId)}`,
      body,
    );
  }

  // ── Channel permissions ──
  channelUserPermissions(channelId, userId) {
    return this.api.get(`/channels/${enc(channelId)}/members/${enc(userId)}/permissions`);
  }

  putChannelUserPermissions(channelId, userId, body) {
    return this.api.put(
      `/channels/${enc(channelId)}/members/${enc(userId)}/permissions`,
      body,
    );
  }

  channelRolePermissions(channelId, roleId) {
    return this.api.get(`/channels/${enc(channelId)}/roles/${enc(roleId)}/permissions`);
  }

  putChannelRolePermissions(channelId, roleId, body) {
    return this.api.put(
      `/channels/${enc(channelId)}/roles/${enc(roleId)}/permissions`,
      body,
    );
  }

  // ── Mute ──
  guildMute(guildId, body) {
    // { mute_seconds | mute_end_timestamp | user_ids? }
    return this.api.patch(`/guilds/${enc(guildId)}/mute`, body);
  }

  memberMute(guildId, userId, body) {
    return this.api.patch(`/guilds/${enc(guildId)}/members/${enc(userId)}/mute`, body);
  }

  // ── Announces ──
  createChannelAnnounce(channelId, messageId) {
    return this.api.post(`/channels/${enc(channelId)}/announces`, { message_id: messageId });
  }

  deleteChannelAnnounce(channelId, messageId = 'all') {
    return this.api.delete(`/channels/${enc(channelId)}/announces/${enc(messageId)}`);
  }

  createGuildAnnounce(guildId, { messageId, channelId }) {
    return this.api.post(`/guilds/${enc(guildId)}/announces`, {
      message_id: messageId,
      channel_id: channelId,
    });
  }

  deleteGuildAnnounce(guildId, messageId = 'all') {
    return this.api.delete(`/guilds/${enc(guildId)}/announces/${enc(messageId)}`);
  }

  // ── Pins ──
  pins(channelId) {
    return this.api.get(`/channels/${enc(channelId)}/pins`);
  }

  addPin(channelId, messageId) {
    return this.api.put(`/channels/${enc(channelId)}/pins/${enc(messageId)}`);
  }

  deletePin(channelId, messageId = 'all') {
    return this.api.delete(`/channels/${enc(channelId)}/pins/${enc(messageId)}`);
  }

  // ── Schedules ──
  schedules(channelId, since = 0) {
    return this.api.get(`/channels/${enc(channelId)}/schedules`, { since });
  }

  schedule(channelId, scheduleId) {
    return this.api.get(`/channels/${enc(channelId)}/schedules/${enc(scheduleId)}`);
  }

  createSchedule(channelId, schedule) {
    return this.api.post(`/channels/${enc(channelId)}/schedules`, { schedule });
  }

  patchSchedule(channelId, scheduleId, schedule) {
    return this.api.patch(`/channels/${enc(channelId)}/schedules/${enc(scheduleId)}`, {
      schedule,
    });
  }

  deleteSchedule(channelId, scheduleId) {
    return this.api.delete(`/channels/${enc(channelId)}/schedules/${enc(scheduleId)}`);
  }

  // ── Reactions ──
  addReaction(channelId, messageId, emojiType, emojiId) {
    return this.api.put(
      `/channels/${enc(channelId)}/messages/${enc(messageId)}/reactions/${enc(emojiType)}/${enc(emojiId)}`,
    );
  }

  deleteOwnReaction(channelId, messageId, emojiType, emojiId) {
    return this.api.delete(
      `/channels/${enc(channelId)}/messages/${enc(messageId)}/reactions/${enc(emojiType)}/${enc(emojiId)}`,
    );
  }

  reactionUsers(channelId, messageId, emojiType, emojiId, query = {}) {
    return this.api.get(
      `/channels/${enc(channelId)}/messages/${enc(messageId)}/reactions/${enc(emojiType)}/${enc(emojiId)}`,
      query,
    );
  }

  // ── Messages (channel) ──
  getMessage(channelId, messageId) {
    return this.api.get(`/channels/${enc(channelId)}/messages/${enc(messageId)}`);
  }

  getMessages(channelId, query = {}) {
    return this.api.get(`/channels/${enc(channelId)}/messages`, query);
  }

  deleteChannelMessage(channelId, messageId, hidetip = false) {
    const q = hidetip ? '?hidetip=true' : '';
    return this.api.delete(`/channels/${enc(channelId)}/messages/${enc(messageId)}${q}`);
  }

  // ── DM ──
  createDm(recipientId, sourceGuildId) {
    return this.api.post('/users/@me/dms', {
      recipient_id: recipientId,
      source_guild_id: sourceGuildId,
    });
  }

  // ── Audio / mic ──
  postAudio(channelId, body) {
    return this.api.post(`/channels/${enc(channelId)}/audio`, body);
  }

  putMic(channelId) {
    return this.api.put(`/channels/${enc(channelId)}/mic`);
  }

  deleteMic(channelId) {
    return this.api.delete(`/channels/${enc(channelId)}/mic`);
  }

  // ── API permissions ──
  apiPermissions(guildId) {
    return this.api.get(`/guilds/${enc(guildId)}/api_permission`);
  }

  requireApiPermissions(guildId, demand) {
    return this.api.post(`/guilds/${enc(guildId)}/api_permission/demand`, demand);
  }

  messageSetting(guildId) {
    return this.api.get(`/guilds/${enc(guildId)}/message/setting`);
  }

  // ── helpers ──
  /**
   * Some DELETE endpoints need a JSON body; ApiGateway.delete may not accept body.
   * Fall back through post/put style if needed via raw token path is not exposed —
   * use apiRequest via getToken + fetch is overkill; try delete first, else put empty.
   * For botgo DELETE with body, we emulate with client if available.
   */
  async apiRequest(method, path, body) {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'GET') return this.api.get(path);
    if (m === 'POST') return this.api.post(path, body);
    if (m === 'PUT') return this.api.put(path, body);
    if (m === 'PATCH') return this.api.patch(path, body);
    if (m === 'DELETE') {
      // Prefer delete; if body required, use put-to-same is wrong.
      // QQBot.api.delete(path) has no body. Use post with _method not supported.
      // Access underlying client via getToken + fetch for body DELETE.
      if (body && Object.keys(body).length) {
        return deleteWithBody(this.api, path, body);
      }
      return this.api.delete(path);
    }
    throw new Error(`unsupported method ${m}`);
  }
}

function enc(v) {
  return encodeURIComponent(String(v));
}

async function deleteWithBody(api, path, body) {
  // QQBot.api exposes getToken; use global fetch against default base.
  const token = await api.getToken();
  const base = 'https://api.sgroup.qq.com';
  const res = await fetch(`${base}${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.msg || text || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

/** Pretty format helpers for QQ text replies. */
export function fmtGuild(g = {}) {
  return [
    `频道: ${g.name || '-'}`,
    `id: ${g.id || '-'}`,
    g.owner_id ? `owner: ${g.owner_id}` : null,
    g.member_count != null ? `成员数: ${g.member_count}` : null,
    g.max_members != null ? `上限: ${g.max_members}` : null,
    g.description ? `简介: ${g.description}` : null,
  ].filter(Boolean).join('\n');
}

export function fmtChannel(c = {}) {
  const typeMap = {
    0: '文字',
    1: '保留',
    2: '语音',
    3: '保留',
    4: '分组',
    10005: '直播',
    10006: '应用',
    10007: '论坛',
  };
  return [
    `#${c.name || '-'}`,
    `id: ${c.id || '-'}`,
    `guild: ${c.guild_id || '-'}`,
    `type: ${typeMap[c.type] || c.type}`,
    c.parent_id ? `父分组: ${c.parent_id}` : null,
    c.position != null ? `排序: ${c.position}` : null,
  ].filter(Boolean).join('\n');
}

export function fmtMember(m = {}) {
  const u = m.user || {};
  return [
    `用户: ${u.username || u.id || m.nick || '-'}`,
    `id: ${u.id || '-'}`,
    m.nick ? `昵称: ${m.nick}` : null,
    Array.isArray(m.roles) && m.roles.length ? `角色: ${m.roles.join(',')}` : null,
    m.joined_at ? `加入: ${m.joined_at}` : null,
  ].filter(Boolean).join('\n');
}

export function fmtRole(r = {}) {
  return `${r.name || '-'} (id=${r.id}, color=${r.color ?? '-'}, hoist=${r.hoist ?? 0}, number=${r.number ?? '-'})`;
}

export function fmtList(title, lines, max = 30) {
  const arr = (lines || []).slice(0, max);
  if (!arr.length) return `${title}\n(空)`;
  return `${title}\n${arr.map((x, i) => `${i + 1}. ${x}`).join('\n')}${lines.length > max ? `\n…共 ${lines.length} 项` : ''}`;
}
