/**
 * QQ inline keyboard helpers (official button interaction).
 * action.type=2 callback; permission.type=2 all users.
 */
export function makeButton(id, label, data, style = 1) {
  return {
    id: String(id).slice(0, 64),
    render_data: {
      label: String(label).slice(0, 40),
      visited_label: String(label).slice(0, 40),
      style: Number(style) || 1,
    },
    action: {
      type: 2,
      permission: { type: 2 },
      data: String(data || id).slice(0, 128),
      click_limit: 10,
    },
  };
}

export function makeKeyboard(rows) {
  return {
    content: {
      rows: (rows || []).map((buttons) => ({ buttons })),
    },
  };
}

/** Quick command keyboard for /help and greetings. */
export function commandKeyboard() {
  return makeKeyboard([
    [
      makeButton('cmd-ping', 'Ping', '/ping', 1),
      makeButton('cmd-status', '状态', '/status', 1),
      makeButton('cmd-services', '服务', '/services', 1),
    ],
    [
      makeButton('cmd-new', '新会话', '/new', 4),
      makeButton('cmd-me', '我的 openid', '/me', 2),
      makeButton('cmd-help', '帮助', '/help', 1),
    ],
  ]);
}

export function servicesKeyboard(services = []) {
  const rows = [];
  const alive = (services || []).filter((s) => s.alive).slice(0, 6);
  if (alive.length) {
    rows.push(
      alive.slice(0, 3).map((s) =>
        makeButton(`stop-${s.port}`, `停 ${s.port}`, `/stop-serve ${s.port}`, 4),
      ),
    );
    if (alive.length > 3) {
      rows.push(
        alive.slice(3, 6).map((s) =>
          makeButton(`stop2-${s.port}`, `停 ${s.port}`, `/stop-serve ${s.port}`, 4),
        ),
      );
    }
  }
  rows.push([
    makeButton('svc-refresh', '刷新服务', '/services', 1),
    makeButton('svc-help', '帮助', '/help', 2),
  ]);
  return makeKeyboard(rows);
}
