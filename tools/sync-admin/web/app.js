const byId = (id) => document.getElementById(id);
let token = '';
let sessionVersion = 0;
let offset = 0;
let listVersion = 0;
let detailVersion = 0;
let refreshVersion = 0;
let editingEnabled = false;
const limit = 50;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function bytes(value) {
  if (value === null || value === undefined) return '未知';
  if (value < 1024) return `${value} B`;
  const unit = value < 1024 ** 2 ? 'KB' : value < 1024 ** 3 ? 'MB' : 'GB';
  const divisor = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return `${(value / divisor).toFixed(2)} ${unit}`;
}

function date(value) {
  if (!value) return '未知';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN');
}

function quotaSourceText(source) {
  return { manual: '管理员固定配额', vip: 'VIP 权益', default: '普通默认' }[source] ?? '服务器有效配置';
}

function quotaDescription(value) {
  return `${bytes(value.quotaLimitBytes)}（${quotaSourceText(value.quotaSource)}）`;
}

function membershipText(membership) {
  return { active: 'VIP 有效', expired: 'VIP 已到期', revoked: 'VIP 已撤销' }[membership?.status] ?? '普通账户';
}

function membershipActionText(action) {
  return { grant: '开通', renew: '续期', revoke: '撤销' }[action] ?? '会员变更';
}

function logout() {
  sessionVersion++;
  listVersion++;
  detailVersion++;
  refreshVersion++;
  editingEnabled = false;
  byId('mode').textContent = '只读';
  token = '';
  byId('token').value = '';
  byId('dashboard').hidden = true;
  byId('login').hidden = false;
  byId('details').hidden = true;
  for (const id of ['summary', 'spaces', 'backups', 'detail-content']) byId(id).replaceChildren();
}

async function api(path, input) {
  const version = sessionVersion;
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(input === undefined ? 10_000 : 60_000),
  });
  if (version !== sessionVersion) throw new Error('session-ended');
  if (response.status === 401) {
    logout();
    byId('notice').textContent = '管理 token 无效，请重新连接。';
    throw new Error('管理 token 无效，请重新连接。');
  }
  const result = await response.json();
  if (version !== sessionVersion) throw new Error('session-ended');
  if (!response.ok) throw new Error(result.message ?? '管理请求失败，请检查服务、备份与审计权限。');
  return result;
}

async function showDetail(handle) {
  const version = ++detailVersion;
  byId('details').hidden = true;
  const detail = await api(`/api/spaces/${encodeURIComponent(handle)}`);
  if (version !== detailVersion) return;
  const content = byId('detail-content');
  content.replaceChildren();
  content.append(node('p', handle, 'handle'));
  content.append(
    node(
      'p',
      `账户：${detail.space.profile?.displayName ?? '未认领'} · 记录数：${detail.space.records ?? '未知'} · 配额计量用量：${bytes(detail.space.quotaBytes)}`,
    ),
  );
  content.append(
    node('p', `密文 JSON 字节数：${bytes(detail.ciphertextJsonBytes)} · 当前记录中的设备数：${detail.deviceCount}`),
  );
  content.append(node('p', `客户端记录更新时间：${date(detail.clientUpdatedAt)}（不代表最近同步时间）`, 'hint'));
  content.append(
    node(
      'p',
      `有效容量上限：${quotaDescription(detail.space)}${detail.space.quotaBytes > detail.space.quotaLimitBytes ? ' · 已超额，仅允许不增加总用量的写入' : ''}`,
    ),
  );
  addMembershipDetail(content, detail.space, detail.membershipHistory ?? []);
  if (editingEnabled) addEditor(content, detail.space, version);
  if (editingEnabled && detail.space.profile && detail.space.membershipsAvailable)
    addMembershipEditor(content, detail.space, version);
  content.append(node('h3', '集合统计'));
  const collections = node('ul');
  for (const item of detail.collections)
    collections.append(node('li', `${item.collection}：${item.records} 条，其中墓碑 ${item.tombstones} 条`));
  if (!detail.collections.length) collections.append(node('li', '暂无记录'));
  content.append(collections, node('h3', '设备统计'));
  const devices = node('ul');
  for (const item of detail.devices)
    devices.append(node('li', `${item.deviceId}：${item.records} 条，客户端更新时间 ${date(item.clientUpdatedAt)}`));
  if (!detail.devices.length) devices.append(node('li', '暂无设备标识'));
  if (detail.deviceCount > detail.devices.length) devices.append(node('li', '仅显示最近 100 个设备标识'));
  content.append(devices);
  byId('details').hidden = false;
  byId('details').querySelector('h2').focus();
}

async function loadList() {
  const version = ++listVersion;
  const query = new URLSearchParams({ q: byId('search').value, offset: String(offset), limit: String(limit) });
  const result = await api(`/api/spaces?${query}`);
  if (version !== listVersion) return;
  const body = byId('spaces');
  body.replaceChildren();
  for (const space of result.spaces) {
    const row = node('tr');
    const profile = node('td');
    profile.append(node('strong', space.profile?.displayName ?? '未认领'));
    if (space.profile) profile.append(node('span', space.profile.accountId, 'account-id'));
    if (space.membershipsAvailable) profile.append(node('span', membershipText(space.membership), 'membership-status'));
    row.append(
      profile,
      node('td', space.spaceHandle, 'handle'),
      node('td', space.records ?? '未知'),
      node('td', `${bytes(space.quotaBytes)} / ${bytes(space.quotaLimitBytes)}`),
      node('td', date(space.createdAt)),
    );
    const action = node('td');
    const button = node('button', '查看', 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => void perform(() => showDetail(space.spaceHandle)));
    action.append(button);
    row.append(action);
    body.append(row);
  }
  if (!result.spaces.length) {
    const cell = node('td', '没有匹配的账户或空间');
    cell.colSpan = 6;
    const row = node('tr');
    row.append(cell);
    body.append(row);
  }
  byId('count').textContent = `共 ${result.total} 个空间，本页 ${result.spaces.length} 个`;
  byId('previous').disabled = offset === 0;
  byId('next').disabled = offset + limit >= result.total;
}

async function refresh() {
  const version = ++refreshVersion;
  detailVersion++;
  byId('details').hidden = true;
  const overview = await api('/api/overview');
  if (version !== refreshVersion) return;
  editingEnabled = overview.editingEnabled === true;
  byId('mode').textContent = editingEnabled ? '可编辑' : '只读';
  const summary = byId('summary');
  summary.replaceChildren();
  const entries = [
    ['已关联账户', overview.profilesAvailable ? overview.accounts : '登记未启用'],
    ['未认领空间', overview.unclaimed],
    ['有效 VIP', overview.membershipsAvailable ? overview.vipActive : '会员未启用'],
    ['已到期 VIP', overview.membershipsAvailable ? overview.vipExpired : '会员未启用'],
    ['已撤销 VIP', overview.membershipsAvailable ? overview.vipRevoked : '会员未启用'],
    ['记录（含墓碑）', overview.records],
    ['配额计量总用量', bytes(overview.quotaBytes)],
    ['同步服务存活', overview.syncHealth.ok ? '正常' : '不可达'],
    ['备份文件', overview.backups.available ? overview.backups.files.length : '未配置 / 不可读'],
  ];
  for (const [label, value] of entries) {
    const card = node('div', undefined, 'stat');
    card.append(node('span', label), node('strong', value));
    summary.append(card);
  }
  const backups = byId('backups');
  backups.replaceChildren();
  if (!overview.backups.available) backups.append(node('p', '备份目录未配置或不可读。'));
  else if (!overview.backups.files.length) backups.append(node('p', '未找到匹配的备份文件。'));
  else {
    const list = node('ul');
    for (const file of overview.backups.files.slice(0, 10))
      list.append(node('li', `${file.file} · ${bytes(file.bytes)} · ${date(file.modifiedAt)}`));
    backups.append(list, node('p', '显示最新 10 份；未进行恢复演练。', 'hint'));
  }
  await loadList();
  if (version !== refreshVersion) return;
  byId('login').hidden = true;
  byId('dashboard').hidden = false;
}

function addEditor(content, space, version) {
  const form = node('form');
  form.className = 'editor';
  form.append(node('h3', '编辑运营资料与存储配额'));
  const accountLabel = node('label', space.profile ? '已关联账户 ID' : '关联账户 ID');
  accountLabel.htmlFor = 'edit-account';
  const account = node('input');
  account.id = 'edit-account';
  account.value = space.profile?.accountId ?? '';
  account.maxLength = 128;
  account.readOnly = !!space.profile;
  account.autocomplete = 'off';
  account.spellcheck = false;
  form.append(accountLabel, account);
  const nameLabel = node('label', '服务器登记显示名');
  nameLabel.htmlFor = 'edit-name';
  const name = node('input');
  name.id = 'edit-name';
  name.value = space.profile?.displayName ?? '';
  name.maxLength = 80;
  name.disabled = !space.profile;
  const defaultLabel = node('label');
  const inherit = node('input');
  inherit.type = 'checkbox';
  inherit.checked = !space.customQuota;
  defaultLabel.append(inherit, document.createTextNode(' 不设固定配额（有效 VIP 容量优先，否则全局默认）'));
  const quotaLabel = node('label', '自定义存储容量（GB，按 1024³ 字节）');
  quotaLabel.htmlFor = 'edit-quota';
  const quota = node('input');
  quota.type = 'number';
  quota.id = 'edit-quota';
  quota.min = '0';
  quota.max = '1024';
  quota.step = 'any';
  quota.value = String(space.quotaLimitBytes / 1024 ** 3);
  quota.disabled = inherit.checked;
  inherit.addEventListener('change', () => {
    quota.disabled = inherit.checked;
    clear();
  });
  const save = node('button', '预览修改');
  save.type = 'submit';
  const confirmation = node('div');
  confirmation.className = 'confirmation';
  let editVersion = 0;
  const clear = () => {
    editVersion++;
    confirmation.replaceChildren();
  };
  account.addEventListener('input', () => {
    name.disabled = !space.profile && account.value.trim() === '';
    clear();
  });
  name.addEventListener('input', clear);
  quota.addEventListener('input', clear);
  form.append(
    nameLabel,
    name,
    defaultLabel,
    quotaLabel,
    quota,
    node(
      'p',
      space.profile
        ? '名称仅修改服务器登记资料，设备本地名称可能在下次登记登录时更新。'
        : '填写原账户 ID。服务器会校验它对应此空间；空显示名默认使用 ID。关联仅登记运营资料，不赋予登录或解密权限。',
      'hint',
    ),
    node('p', '0 表示禁止新增用量。降低配额不会删除数据；保存前先自动创建完整一致性备份。', 'hint'),
    save,
    confirmation,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(async () => {
      clear();
      const requestVersion = editVersion;
      save.disabled = true;
      try {
        const maxBytes = inherit.checked ? null : Math.round(Number(quota.value) * 1024 ** 3);
        if (!inherit.checked && (quota.value.trim() === '' || !Number.isFinite(Number(quota.value))))
          throw new Error('请输入有效容量。');
        const preview = await api('/api/changes/prepare', {
          spaceHandle: space.spaceHandle,
          maxBytes,
          ...(space.profile ? { displayName: name.value } : {}),
          ...(!space.profile && account.value.trim() !== ''
            ? { accountId: account.value, ...(name.value.trim() === '' ? {} : { displayName: name.value }) }
            : {}),
        });
        if (version !== detailVersion || requestVersion !== editVersion) return;
        confirmation.append(
          node('h3', '二次确认'),
          node('p', `有效容量：${quotaDescription(preview.before)} → ${quotaDescription(preview.after)}`),
        );
        if (preview.before.accountId !== preview.after.accountId)
          confirmation.append(
            node('p', `账户 ID：${preview.before.accountId ?? '未关联'} → ${preview.after.accountId}`),
          );
        if (preview.before.displayName !== preview.after.displayName)
          confirmation.append(
            node('p', `显示名：${preview.before.displayName ?? '未登记'} → ${preview.after.displayName}`),
          );
        confirmation.append(
          node('p', `目标空间：${space.spaceHandle}`, 'handle'),
          node('p', '确认 2 分钟内有效。请输入完整空间句柄：'),
        );
        const label = node('label', '确认空间句柄');
        label.htmlFor = 'confirm-handle';
        const handle = node('input');
        handle.id = 'confirm-handle';
        handle.autocomplete = 'off';
        handle.spellcheck = false;
        const confirm = node('button', '备份并保存');
        confirm.type = 'button';
        confirm.disabled = true;
        handle.addEventListener('input', () => {
          confirm.disabled = handle.value !== space.spaceHandle;
        });
        const cancel = node('button', '取消确认', 'secondary');
        cancel.type = 'button';
        cancel.addEventListener('click', clear);
        confirm.addEventListener(
          'click',
          () =>
            void perform(async () => {
              confirm.disabled = true;
              cancel.disabled = true;
              try {
                const result = await api('/api/changes/commit', {
                  confirmationId: preview.confirmationId,
                  confirmSpaceHandle: handle.value,
                });
                if (version !== detailVersion) return;
                await refresh();
                await showDetail(space.spaceHandle);
                byId('notice').textContent =
                  `修改已保存；前置备份：${result.backupFile}${result.auditWarning ? ` · ${result.auditWarning}` : ''}`;
              } finally {
                clear();
              }
            }),
        );
        confirmation.append(label, handle, confirm, cancel);
      } finally {
        save.disabled = false;
      }
    });
  });
  content.append(form);
}

function addMembershipDetail(content, space, history) {
  content.append(node('h3', 'VIP 权益'));
  if (!space.membershipsAvailable) {
    content.append(node('p', '服务器会员管理尚未启用。', 'hint'));
    return;
  }
  const membership = space.membership;
  content.append(node('p', `会员状态：${membershipText(membership)}（状态以刷新时服务器时间为准）`));
  if (membership) {
    content.append(
      node('p', `开通时间：${date(membership.startedAt)} · 到期时间：${date(membership.expiresAt)}`),
      node('p', `VIP 存储权益：${bytes(membership.maxBytes)} · 当前有效容量：${quotaDescription(space)}`),
    );
    if (membership.revokedAt) content.append(node('p', `撤销时间：${date(membership.revokedAt)}`));
  }
  content.append(
    node(
      'p',
      '管理员固定配额始终优先，包括 0。未设固定配额时，VIP 到期或撤销后恢复普通默认容量；已有数据保留，超额时仅允许不增加总用量的写入。',
      'hint',
    ),
    node('p', '当前 VIP 权益仅包含会员期限和服务器存储额度；运营方托管 API 服务尚未接通。', 'hint'),
  );
  if (!space.profile) content.append(node('p', '请先关联账户 ID，再管理会员。', 'hint'));
  content.append(node('h3', '权益变更记录'));
  const list = node('ul');
  for (const item of history)
    list.append(
      node(
        'li',
        `${date(item.eventAt)} · ${membershipActionText(item.action)} · 到期 ${date(item.expiresAt)} · VIP 容量 ${bytes(item.maxBytes)}`,
      ),
    );
  if (!history.length) list.append(node('li', '暂无会员变更记录'));
  content.append(list, node('p', '显示当前空间最近 20 条会员变更。', 'hint'));
}

function addMembershipEditor(content, space, version) {
  const form = node('form', undefined, 'editor');
  form.append(node('h3', '管理 VIP 会员'));
  const actionLabel = node('label', '会员操作');
  actionLabel.htmlFor = 'membership-action';
  const action = node('select');
  action.id = 'membership-action';
  const status = space.membership?.status;
  const actions =
    status === 'active' ? ['renew', 'revoke'] : status === 'expired' ? ['renew', 'grant', 'revoke'] : ['grant'];
  for (const item of actions) {
    const option = node('option', membershipActionText(item));
    option.value = item;
    action.append(option);
  }
  const daysLabel = node('label', '有效期（天，1 至 3650）');
  daysLabel.htmlFor = 'membership-days';
  const days = node('input');
  days.id = 'membership-days';
  days.type = 'number';
  days.min = '1';
  days.max = '3650';
  days.step = '1';
  days.value = '30';
  const quotaLabel = node('label', 'VIP 存储容量（MB，按 1024² 字节）');
  quotaLabel.htmlFor = 'membership-quota';
  const quota = node('input');
  quota.id = 'membership-quota';
  quota.type = 'number';
  quota.min = String(1 / 1024 ** 2);
  quota.max = String(1024 ** 2);
  quota.step = 'any';
  quota.value = String(space.membership?.maxBytes ? space.membership.maxBytes / 1024 ** 2 : 1024);
  const fields = node('div');
  fields.append(daysLabel, days, quotaLabel, quota);
  const save = node('button', '预览会员变更');
  save.type = 'submit';
  const confirmation = node('div', undefined, 'confirmation');
  let editVersion = 0;
  let expiryTimer;
  const clear = () => {
    editVersion++;
    clearTimeout(expiryTimer);
    confirmation.replaceChildren();
  };
  const updateAction = () => {
    const revoke = action.value === 'revoke';
    fields.hidden = revoke;
    days.disabled = revoke;
    quota.disabled = revoke;
    clear();
  };
  action.addEventListener('change', updateAction);
  days.addEventListener('input', clear);
  quota.addEventListener('input', clear);
  form.append(
    actionLabel,
    action,
    fields,
    node('p', '有效会员续期从原到期时间延长；已到期会员从服务器当前时间重新开始。预览会列出实际到期时间。', 'hint'),
    node('p', '每次变更都需完整空间句柄二次确认，并先自动备份。固定配额优先，开通 VIP 不会自动取消固定配额。', 'hint'),
    save,
    confirmation,
  );
  updateAction();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void perform(async () => {
      clear();
      const requestVersion = editVersion;
      save.disabled = true;
      try {
        const membership = { action: action.value };
        if (action.value !== 'revoke') {
          const durationDays = Number(days.value);
          const maxBytes = Math.round(Number(quota.value) * 1024 ** 2);
          if (days.value.trim() === '' || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)
            throw new Error('有效期须为 1 至 3650 的整数天。');
          if (quota.value.trim() === '' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 ** 4)
            throw new Error('VIP 容量须大于 0，且不超过 1 TB。');
          membership.durationDays = durationDays;
          membership.maxBytes = maxBytes;
        }
        const preview = await api('/api/changes/prepare', { spaceHandle: space.spaceHandle, membership });
        if (version !== detailVersion || requestVersion !== editVersion) return;
        confirmation.append(
          node('h3', '二次确认会员变更'),
          node('p', `操作：${membershipActionText(membership.action)}`),
          node(
            'p',
            `会员状态：${membershipText(preview.before.membership)} → ${membershipText(preview.after.membership)}`,
          ),
          node(
            'p',
            `到期时间：${date(preview.before.membership?.expiresAt)} → ${date(preview.after.membership?.expiresAt)}`,
          ),
          node(
            'p',
            `VIP 容量：${bytes(preview.before.membership?.maxBytes)} → ${bytes(preview.after.membership?.maxBytes)}`,
          ),
          node('p', `有效容量：${quotaDescription(preview.before)} → ${quotaDescription(preview.after)}`),
          node('p', `目标账户：${preview.after.accountId ?? space.profile.accountId}`),
          node('p', `目标空间：${space.spaceHandle}`, 'handle'),
          node('p', `确认截至 ${date(preview.expiresAt)} 有效。请输入完整空间句柄：`),
        );
        const handleLabel = node('label', '确认会员变更的空间句柄');
        handleLabel.htmlFor = 'membership-confirm-handle';
        const handle = node('input');
        handle.id = 'membership-confirm-handle';
        handle.autocomplete = 'off';
        handle.spellcheck = false;
        const confirm = node('button', '备份并保存会员变更');
        confirm.type = 'button';
        confirm.disabled = true;
        const expired = () => Date.now() >= preview.expiresAt;
        handle.addEventListener('input', () => {
          confirm.disabled = handle.value !== space.spaceHandle || expired();
        });
        const cancel = node('button', '取消确认', 'secondary');
        cancel.type = 'button';
        cancel.addEventListener('click', clear);
        expiryTimer = setTimeout(
          () => {
            if (version !== detailVersion || requestVersion !== editVersion) return;
            clear();
            confirmation.append(node('p', '确认已过期，请重新预览会员变更。', 'hint'));
          },
          Math.max(0, preview.expiresAt - Date.now()),
        );
        confirm.addEventListener(
          'click',
          () =>
            void perform(async () => {
              if (version !== detailVersion || requestVersion !== editVersion) return;
              if (expired()) throw new Error('确认已过期，请重新预览会员变更。');
              if (handle.value !== space.spaceHandle) throw new Error('请输入完整空间句柄。');
              confirm.disabled = true;
              cancel.disabled = true;
              for (const control of [action, days, quota, save, handle]) control.disabled = true;
              clearTimeout(expiryTimer);
              try {
                const result = await api('/api/changes/commit', {
                  confirmationId: preview.confirmationId,
                  confirmSpaceHandle: handle.value,
                });
                if (version !== detailVersion) return;
                await refresh();
                await showDetail(space.spaceHandle);
                byId('notice').textContent =
                  `会员变更已保存；前置备份：${result.backupFile}${result.auditWarning ? ` · ${result.auditWarning}` : ''}`;
              } finally {
                action.disabled = false;
                days.disabled = action.value === 'revoke';
                quota.disabled = action.value === 'revoke';
                save.disabled = false;
                clear();
              }
            }),
        );
        confirmation.append(handleLabel, handle, confirm, cancel);
      } finally {
        save.disabled = false;
      }
    });
  });
  content.append(form);
}

async function perform(work) {
  const version = sessionVersion;
  byId('notice').textContent = '';
  try {
    await work();
  } catch (error) {
    if (version === sessionVersion)
      byId('notice').textContent =
        error instanceof Error
          ? error.name === 'TimeoutError'
            ? '请求超时；若刚提交，请刷新核对结果后再试。'
            : error.message
          : '连接失败，请检查 SSH 隧道。';
  }
}

byId('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sessionVersion++;
  token = byId('token').value.trim();
  byId('token').value = '';
  offset = 0;
  void perform(refresh);
});
byId('logout').addEventListener('click', logout);
byId('refresh').addEventListener('click', () => void perform(refresh));
byId('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  offset = 0;
  detailVersion++;
  byId('details').hidden = true;
  void perform(loadList);
});
byId('previous').addEventListener('click', () => {
  offset = Math.max(0, offset - limit);
  void perform(loadList);
});
byId('next').addEventListener('click', () => {
  offset += limit;
  void perform(loadList);
});
window.addEventListener('pagehide', logout);
