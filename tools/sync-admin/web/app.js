const byId = (id) => document.getElementById(id);
// Reuse the existing wrapping style for long audit identifiers on narrow screens.
byId('notice').className = 'handle';
let token = '';
let sessionVersion = 0;
let offset = 0;
let committedQuery = '';
let listPending = false;
let displayedOffset = 0;
let displayedQuery = '';
let listTotal = 0;
const readTimes = new Map();
let listVersion = 0;
let detailVersion = 0;
let selectedDetailHandle = '';
let refreshVersion = 0;
let editingEnabled = false;
const limit = 50;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function readStatus(id, phase, error) {
  if (phase === 'success') readTimes.set(id, Date.now());
  const last = readTimes.get(id);
  byId(id).textContent = [
    phase === 'loading'
      ? '读取中…'
      : phase === 'error'
        ? `读取失败：${error instanceof Error ? error.message : String(error)}；请重试。`
        : '读取完成。',
    last ? `最近成功读取：${date(last)}${phase !== 'success' ? '（上次读取，当前可能已变化）' : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function formFeedback(form) {
  const feedback = node('p', undefined, 'local-status');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  form.append(feedback);
  return feedback;
}

function commitError(message) {
  byId('operation-result').textContent = message;
  return new Error(message);
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

function moneyNanoyuan(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return '未知';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = String(absolute % 1_000_000_000n)
    .padStart(9, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `¥${amount < 0n ? '-' : ''}${absolute / 1_000_000_000n}.${fraction}`;
}

function priceText(fen) {
  return Number.isSafeInteger(fen) && fen >= 0 ? moneyNanoyuan(String(BigInt(fen) * 10_000_000n)) : '未知';
}

function billingStatusText(status) {
  return (
    {
      'schema-unavailable': '托管账本尚未启用',
      'vip-inactive': 'VIP 到期或撤销，余额保留并冻结',
      'paid-expired': 'API 付费资格已到期，余额保留并冻结',
      'no-paid-eligibility': '尚无 API 付费资格',
      'no-account': '未发放托管额度，尚无 API 付费资格',
      'space-changed': '空间身份已变化，请刷新重新核对',
      'insufficient-balance': '额度不足',
      'pending-review': '存在待核对调用，预留保持冻结',
      ready: '账本资格有效；调用还需网关开放及足够预留',
      active: '账本资格有效；调用还需网关开放及足够预留',
    }[status] ?? '请核对会员、付费资格、余额和未决调用'
  );
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
  return (
    { grant: '开通', renew: '续期', revoke: '撤销', purchase: '套餐购买／付费续期（管理员确认）' }[action] ?? '会员变更'
  );
}

function capacityValue(value, unit, allowZero = true) {
  const amount = Number(value);
  const multiplier = { MB: 1024 ** 2, GB: 1024 ** 3 }[unit];
  const result = Math.round(amount * multiplier);
  if (
    String(value).trim() === '' ||
    !multiplier ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount * multiplier > 1024 ** 4 ||
    !Number.isSafeInteger(result) ||
    result < (allowZero ? 0 : 1)
  )
    throw new Error(`容量须${allowZero ? '为 0 或正数' : '大于 0'}，且不超过 1 TB。`);
  return result;
}

function convertCapacity(value, from, to) {
  const units = { MB: 1024 ** 2, GB: 1024 ** 3 };
  if (!units[from] || !units[to] || String(value).trim() === '' || !Number.isFinite(Number(value)))
    throw new Error('请输入有效容量。');
  return (Number(value) * units[from]) / units[to];
}

function capacityControls(id, initialBytes, { allowZero = true, onChange, onPreset } = {}) {
  const container = node('div', undefined, 'capacity-control');
  const row = node('div', undefined, 'capacity-row');
  const input = node('input');
  input.id = id;
  input.type = 'number';
  input.step = 'any';
  const unit = node('select');
  unit.id = `${id}-unit`;
  unit.setAttribute('aria-label', '容量单位');
  for (const value of ['MB', 'GB']) {
    const option = node('option', value);
    option.value = value;
    unit.append(option);
  }
  let previousUnit;
  let enabled = true;
  const presets = node('div', undefined, 'presets');
  presets.setAttribute('aria-label', '常用存储容量');
  const choices = [96, 256, 512, 1024, 5120];
  const buttons = choices.map((mb) => {
    const button = node('button', mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`, 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      onPreset?.();
      setBytes(mb * 1024 ** 2);
      onChange?.();
    });
    presets.append(button);
    return button;
  });
  const update = () => {
    input.min = allowZero ? '0' : String(1 / (unit.value === 'MB' ? 1024 ** 2 : 1024 ** 3));
    input.max = unit.value === 'MB' ? String(1024 ** 2) : '1024';
    let selected;
    try {
      selected = capacityValue(input.value, unit.value, allowZero);
    } catch {
      selected = null;
    }
    buttons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(enabled && selected === choices[index] * 1024 ** 2));
    });
  };
  function setBytes(value) {
    unit.value = value >= 1024 ** 3 ? 'GB' : 'MB';
    previousUnit = unit.value;
    input.value = String(value / (unit.value === 'MB' ? 1024 ** 2 : 1024 ** 3));
    update();
  }
  input.addEventListener('input', () => {
    update();
    onChange?.();
  });
  unit.addEventListener('change', () => {
    if (input.value.trim() !== '') input.value = String(convertCapacity(input.value, previousUnit, unit.value));
    previousUnit = unit.value;
    update();
    onChange?.();
  });
  row.append(input, unit);
  container.append(row, presets);
  setBytes(initialBytes);
  return {
    container,
    input,
    unit,
    value: () => capacityValue(input.value, unit.value, allowZero),
    disable(disabled, lockPresets = false) {
      enabled = !disabled;
      input.disabled = disabled;
      unit.disabled = disabled;
      for (const button of buttons) button.disabled = lockPresets;
      update();
    },
  };
}

function handleCopy(value, operation = false) {
  const row = node('div', undefined, 'handle-copy');
  const source = node('input');
  source.value = value;
  source.readOnly = true;
  source.setAttribute('aria-label', operation ? '待复制的操作编号' : '待复制的完整空间句柄');
  const copy = node('button', operation ? '复制操作编号' : '复制完整句柄', 'secondary');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    source.select();
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = operation ? '操作编号已复制' : '已复制，请粘贴到确认框';
    } catch {
      copy.textContent = '已选中，请按 Ctrl+C 复制';
    }
  });
  row.append(source, copy);
  return row;
}

function logout() {
  sessionVersion++;
  listVersion++;
  detailVersion++;
  refreshVersion++;
  editingEnabled = false;
  listPending = false;
  committedQuery = displayedQuery = '';
  offset = displayedOffset = listTotal = 0;
  readTimes.clear();
  selectedDetailHandle = '';
  byId('search').value = '';
  for (const id of ['list-status', 'overview-status', 'detail-status', 'operation-result']) byId(id).textContent = '';
  byId('mode').textContent = '只读';
  token = '';
  byId('token').value = '';
  byId('dashboard').hidden = true;
  byId('login').hidden = false;
  byId('details').hidden = true;
  for (const id of ['summary', 'spaces', 'backups', 'detail-content']) byId(id).replaceChildren();
}

function operationNotice(result) {
  return [
    typeof result?.operationId === 'string' && result.operationId ? `操作编号：${result.operationId}` : '',
    typeof result?.confirmationHash === 'string' && result.confirmationHash
      ? `确认摘要：${result.confirmationHash}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

async function showOperationResult(result, message, refreshDetails, submittedDetailVersion = detailVersion) {
  const version = sessionVersion;
  const saved = `${message}；前置备份：${result.backupFile}${result.auditWarning ? ` · ${result.auditWarning}` : ''}${operationNotice(result) ? ` · ${operationNotice(result)}` : ''}`;
  byId('notice').textContent = saved;
  byId('operation-result').textContent = saved;
  if (detailVersion !== submittedDetailVersion) return;
  try {
    const refreshing = refresh();
    // refresh invalidates the old detail immediately. A later user selection
    // belongs to a newer detail generation and must stay open.
    const expectedDetail = detailVersion;
    await refreshing;
    if (version !== sessionVersion) return;
    if (detailVersion === expectedDetail) await refreshDetails();
    if (version === sessionVersion) {
      byId('notice').textContent = saved;
      byId('operation-result').textContent = saved;
    }
  } catch (error) {
    if (version === sessionVersion) {
      const message = `${saved} · 已保存，但刷新失败：${error instanceof Error ? error.message : String(error)}；请刷新核对。`;
      byId('notice').textContent = message;
      byId('operation-result').textContent = message;
    }
  }
}

async function api(path, input, preparedOperation) {
  const version = sessionVersion;
  let response;
  try {
    response = await fetch(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(input === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(input === undefined ? 10_000 : 60_000),
    });
  } catch (error) {
    if (version !== sessionVersion) throw new Error('session-ended');
    if (path === '/api/changes/commit') {
      const correlation = operationNotice(preparedOperation);
      throw commitError(
        `提交连接中断或超时，结果尚未确认；请按操作编号核对审计与当前数据，再决定下一步${correlation ? ` · ${correlation}` : ''}。`,
      );
    }
    throw error;
  }
  if (version !== sessionVersion) throw new Error('session-ended');
  if (response.status === 401) {
    logout();
    byId('notice').textContent = '管理 token 无效，请重新连接。';
    throw new Error('管理 token 无效，请重新连接。');
  }
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (version !== sessionVersion) throw new Error('session-ended');
    if (path === '/api/changes/commit') {
      const correlation = operationNotice(preparedOperation);
      throw commitError(
        `提交响应未能读取，结果尚未确认；请按操作编号核对审计与当前数据${correlation ? ` · ${correlation}` : ''}。`,
      );
    }
    throw error;
  }
  if (version !== sessionVersion) throw new Error('session-ended');
  if (!response.ok) {
    const correlation = operationNotice({ ...preparedOperation, ...result });
    const message = `${result.message ?? '管理请求失败，请检查服务、备份与审计权限。'}${correlation ? ` · ${correlation}` : ''}`;
    throw path === '/api/changes/commit' ? commitError(message) : new Error(message);
  }
  return result;
}

async function showDetail(handle, mode = 'details') {
  const version = ++detailVersion;
  byId('details').hidden = false;
  byId('detail-content').replaceChildren(node('p', handle, 'handle'));
  if (selectedDetailHandle !== handle) readTimes.delete('detail-status');
  selectedDetailHandle = handle;
  readStatus('detail-status', 'loading');
  let detail, catalog;
  try {
    [detail, catalog] = await Promise.all([
      api(`/api/spaces/${encodeURIComponent(handle)}`),
      editingEnabled ? api('/api/plans') : Promise.resolve({ plans: [] }),
    ]);
  } catch (error) {
    if (version !== detailVersion) return;
    readStatus('detail-status', 'error', error);
    throw error;
  }
  if (version !== detailVersion) return;
  readStatus('detail-status', 'success');
  const content = byId('detail-content');
  content.replaceChildren();
  byId('details').querySelector('h2').textContent =
    mode === 'quota' ? '设置存储配额' : mode === 'vip' ? '管理 VIP 会员' : '空间详情';
  content.append(node('p', handle, 'handle'));
  content.append(
    node(
      'p',
      `账户：${detail.space.profile?.displayName ?? '未认领'} · 记录数：${detail.space.records ?? '未知'} · 配额计量用量：${bytes(detail.space.quotaBytes)}`,
    ),
  );
  if (mode !== 'details') {
    if (detail.space.profile) content.append(node('p', `账户 ID：${detail.space.profile.accountId}`));
    content.append(node('p', `当前有效容量：${quotaDescription(detail.space)}`));
    if (mode === 'vip') addBillingDetail(content, detail.apiBilling);
    if (editingEnabled) {
      if (mode === 'quota') addEditor(content, detail.space, version, true);
      else if (detail.space.profile && detail.space.membershipsAvailable)
        addMembershipControls(content, detail.space, version, catalog.plans, detail.apiBilling);
      else content.append(node('p', '请先关联账户 ID，并确认服务器会员管理已启用。'));
    } else content.append(node('p', '当前为只读模式。'));
    const back = node('button', '查看完整详情', 'secondary');
    back.type = 'button';
    back.addEventListener('click', () => void perform(() => showDetail(handle)));
    content.append(back);
    byId('details').hidden = false;
    byId('details').scrollIntoView({ block: 'start' });
    byId('details').querySelector('h2').focus({ preventScroll: true });
    return;
  }
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
  addBillingDetail(content, detail.apiBilling);
  if (editingEnabled) addEditor(content, detail.space, version);
  if (editingEnabled && detail.space.profile && detail.space.membershipsAvailable)
    addMembershipControls(content, detail.space, version, catalog.plans, detail.apiBilling);
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
  const queryText = committedQuery;
  let requestOffset = offset;
  listPending = true;
  byId('previous').disabled = true;
  byId('next').disabled = true;
  byId('spaces').setAttribute?.('aria-busy', 'true');
  readStatus('list-status', 'loading');
  try {
    let result;
    while (true) {
      const query = new URLSearchParams({ q: queryText, offset: String(requestOffset), limit: String(limit) });
      result = await api(`/api/spaces?${query}`);
      if (version !== listVersion) return;
      if (requestOffset > 0 && requestOffset >= result.total) {
        requestOffset = 0;
        continue;
      }
      break;
    }
    offset = displayedOffset = requestOffset;
    displayedQuery = queryText;
    listTotal = result.total;
    const body = byId('spaces');
    body.replaceChildren();
    for (const space of result.spaces) {
      const row = node('tr');
      const profile = node('td');
      profile.append(node('strong', space.profile?.displayName ?? '未认领'));
      if (space.profile) profile.append(node('span', space.profile.accountId, 'account-id'));
      if (space.membershipsAvailable)
        profile.append(node('span', membershipText(space.membership), 'membership-status'));
      row.append(
        profile,
        node('td', space.spaceHandle, 'handle'),
        node('td', space.records ?? '未知'),
        node('td', `${bytes(space.quotaBytes)} / ${bytes(space.quotaLimitBytes)}`),
        node('td', date(space.createdAt)),
      );
      const action = node('td');
      action.className = 'row-actions';
      const button = node('button', '查看', 'secondary');
      button.type = 'button';
      button.addEventListener('click', () => void perform(() => showDetail(space.spaceHandle)));
      action.append(button);
      if (editingEnabled) {
        const quota = node('button', '配额', 'secondary');
        quota.type = 'button';
        quota.addEventListener('click', () => void perform(() => showDetail(space.spaceHandle, 'quota')));
        action.append(quota);
        if (space.profile && space.membershipsAvailable) {
          const vip = node(
            'button',
            space.membership && space.membership.status !== 'revoked' ? '续期 VIP' : '开通 VIP',
          );
          vip.type = 'button';
          vip.addEventListener('click', () => void perform(() => showDetail(space.spaceHandle, 'vip')));
          action.append(vip);
        }
      }
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
    readStatus('list-status', 'success');
  } catch (error) {
    if (version !== listVersion) return;
    offset = displayedOffset;
    readStatus('list-status', 'error', error);
    throw error;
  } finally {
    if (version === listVersion) {
      listPending = false;
      byId('spaces').setAttribute?.('aria-busy', 'false');
      const snapshotMatchesQuery = displayedQuery === committedQuery;
      byId('previous').disabled = !snapshotMatchesQuery || displayedOffset === 0;
      byId('next').disabled = !snapshotMatchesQuery || displayedOffset + limit >= listTotal;
    }
  }
}

async function refresh() {
  const version = ++refreshVersion;
  detailVersion++;
  byId('details').hidden = true;
  byId('refresh').disabled = true;
  readStatus('overview-status', 'loading');
  try {
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
    readStatus('overview-status', 'success');
  } catch (error) {
    if (version !== refreshVersion) return;
    readStatus('overview-status', 'error', error);
    throw error;
  } finally {
    if (version === refreshVersion) byId('refresh').disabled = false;
  }
}

function addEditor(content, space, version, quotaOnly = false) {
  const form = node('form');
  form.className = 'editor';
  const feedback = formFeedback(form);
  form.append(node('h3', quotaOnly ? '选择存储额度' : '编辑运营资料与存储配额'));
  const accountLabel = node('label', space.profile ? '已关联账户 ID' : '关联账户 ID');
  accountLabel.htmlFor = 'edit-account';
  const account = node('input');
  account.id = 'edit-account';
  account.value = space.profile?.accountId ?? '';
  account.maxLength = 128;
  account.readOnly = !!space.profile;
  account.autocomplete = 'off';
  account.spellcheck = false;
  if (!quotaOnly) form.append(accountLabel, account);
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
  const quotaLabel = node('label', '固定存储容量');
  quotaLabel.htmlFor = 'edit-quota';
  const capacity = capacityControls('edit-quota', space.quotaLimitBytes, {
    onChange: () => clear(),
    onPreset: () => {
      inherit.checked = false;
      capacity.disable(false);
    },
  });
  capacity.disable(inherit.checked);
  inherit.addEventListener('change', () => {
    capacity.disable(inherit.checked);
    clear();
  });
  const save = node('button', '预览修改');
  save.type = 'submit';
  const confirmation = node('div');
  confirmation.className = 'confirmation';
  let editVersion = 0;
  let expiryTimer;
  const clear = () => {
    editVersion++;
    clearTimeout(expiryTimer);
    confirmation.replaceChildren();
  };
  account.addEventListener('input', () => {
    name.disabled = !space.profile && account.value.trim() === '';
    clear();
  });
  name.addEventListener('input', clear);
  if (!quotaOnly) form.append(nameLabel, name);
  form.append(
    defaultLabel,
    quotaLabel,
    capacity.container,
    node('p', '点容量快捷项即选择固定配额，也可直接填写数值；MB／GB 均按 1024 换算。', 'hint'),
    node(
      'p',
      quotaOnly
        ? '只修改容量，不更改账户 ID、显示名或会员期限。'
        : space.profile
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
    if (save.disabled) return;
    void perform(async () => {
      clear();
      const requestVersion = editVersion;
      save.disabled = true;
      feedback.textContent = '预览读取中…';
      try {
        const maxBytes = inherit.checked ? null : capacity.value();
        const preview = await api('/api/changes/prepare', {
          spaceHandle: space.spaceHandle,
          maxBytes,
          ...(!quotaOnly && space.profile ? { displayName: name.value } : {}),
          ...(!quotaOnly && !space.profile && account.value.trim() !== ''
            ? { accountId: account.value, ...(name.value.trim() === '' ? {} : { displayName: name.value }) }
            : {}),
        });
        if (version !== detailVersion || requestVersion !== editVersion) return;
        feedback.textContent = '预览已读取，请核对并手动填写完整空间句柄。';
        confirmation.append(
          node('h3', '二次确认'),
          node('p', operationNotice(preview), 'hint handle'),
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
          handleCopy(space.spaceHandle),
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
        const expired = () => Date.now() >= preview.expiresAt;
        handle.addEventListener('input', () => {
          confirm.disabled = handle.value !== space.spaceHandle || expired();
        });
        const cancel = node('button', '取消确认', 'secondary');
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
          clear();
          save.focus();
        });
        expiryTimer = setTimeout(
          () => {
            if (version !== detailVersion || requestVersion !== editVersion) return;
            clear();
            confirmation.append(node('p', '确认已过期，请重新预览。', 'hint'));
          },
          Math.max(0, preview.expiresAt - Date.now()),
        );
        confirm.addEventListener(
          'click',
          () =>
            void perform(async () => {
              if (confirm.disabled) return;
              if (version !== detailVersion || requestVersion !== editVersion) return;
              if (expired()) throw new Error('确认已过期，请重新预览。');
              if (handle.value !== space.spaceHandle) throw new Error('请输入完整空间句柄。');
              confirm.disabled = true;
              cancel.disabled = true;
              clearTimeout(expiryTimer);
              capacity.disable(true, true);
              for (const control of [account, name, inherit, save, handle]) control.disabled = true;
              feedback.textContent = '保存中…正在备份并提交，请等待结果。';
              try {
                const result = await api(
                  '/api/changes/commit',
                  {
                    confirmationId: preview.confirmationId,
                    confirmSpaceHandle: handle.value,
                  },
                  preview,
                );
                await showOperationResult(
                  result,
                  '修改已保存',
                  () => showDetail(space.spaceHandle, quotaOnly ? 'quota' : 'details'),
                  version,
                );
                feedback.textContent = byId('operation-result').textContent;
              } finally {
                capacity.disable(inherit.checked);
                account.disabled = false;
                name.disabled = !space.profile && account.value.trim() === '';
                for (const control of [inherit, save, handle]) control.disabled = false;
                clear();
              }
            }, feedback),
        );
        confirmation.append(label, handle, confirm, cancel);
        handle.focus();
      } finally {
        save.disabled = false;
      }
    }, feedback);
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
    node('p', 'API 余额及付费资格独立记账。赠送或人工延长会员时间不发放额度，也不延长 API 付费资格。', 'hint'),
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

function addBillingDetail(content, billing) {
  const section = node('section', undefined, 'billing-detail');
  section.append(
    node('h3', '托管 API 账本'),
    node('p', billing?.serviceStatus ?? '托管网关尚未对最终用户开放', 'hint'),
  );
  if (!billing?.available) {
    section.append(node('p', '托管账本尚未启用，无托管计费数据。', 'hint'));
    content.append(section);
    return;
  }
  const summary = node('div', undefined, 'billing-summary');
  for (const [label, value] of [
    ['账本余额', billing.balanceNanoyuan],
    ['调用预留', billing.reservedNanoyuan],
    ['可用余额', billing.availableNanoyuan],
    ['累计发放', billing.grantedNanoyuan],
    ['累计消费', billing.spentNanoyuan],
  ]) {
    const item = node('div');
    item.append(node('span', label), node('strong', moneyNanoyuan(value)));
    summary.append(item);
  }
  section.append(
    summary,
    node('p', `API 付费资格：${billing.paidActive ? '有效' : '未取得或已到期'} · 截止 ${date(billing.paidUntil)}`),
    node('p', `存储 VIP：${billing.vipActive ? '有效' : '无效'} · ${billingStatusText(billing.status)}`),
    node(
      'p',
      '到期或撤销会员后保留余额并暂停调用；赠送延期不恢复已到期的付费资格。新调用需满足保守预留要求，少量可用余额可能仍不足以发起调用。',
      'hint',
    ),
    node('h3', '套餐购买记录'),
  );
  if (billing.availableNanoyuan === '0')
    summary.after(node('p', '可用余额为 0，额度不足；未结算预留仍保持冻结。', 'quota-warning'));
  const purchases = billing.purchases ?? [];
  const purchaseList = node('ul', undefined, 'billing-history');
  for (const item of purchases) {
    const entry = node(
      'li',
      `${date(item.eventAt)} · ${item.planName}（${item.planId} / ${item.planVersion}）· ${item.durationDays} 天 / ${bytes(item.maxBytes)} · 标价 ${priceText(item.priceFen)} · 整期发放 ${moneyNanoyuan(item.creditNanoyuan)} · 付费资格至 ${date(item.paidUntil)}`,
    );
    const operationId = typeof item.operationId === 'string' ? item.operationId : '';
    entry.append(
      node('p', operationId ? `操作编号：${operationId}` : '操作编号：未知（旧记录未提供）', 'hint operation-id'),
    );
    if (operationId) entry.append(handleCopy(operationId, true));
    purchaseList.append(entry);
  }
  if (!purchases.length) purchaseList.append(node('li', '未发放托管额度；历史自定义会员未记录标价，不补推购买记录。'));
  section.append(
    purchaseList,
    node('p', '显示当前空间最近 50 笔管理员确认的购买；记录不构成支付平台收款证明。', 'hint'),
  );
  section.append(node('h3', '托管调用记录'));
  const requests = billing.requests ?? [];
  const callList = node('ul', undefined, 'billing-history');
  const states = { reserved: '已预留', sent: '已发送', settled: '已结算', pending: '待核对', released: '发送前已释放' };
  for (const item of requests) {
    const entry = node('li');
    entry.append(
      node(
        'p',
        `${date(item.startedAt)} · ${item.requestId} · ${states[item.state] ?? '未知状态'} · ${item.model} · 预留 ${moneyNanoyuan(item.reservedNanoyuan)} · 费用 ${item.chargedNanoyuan === null ? (item.state === 'released' ? '未发送，无消费' : '未结算／待核对') : moneyNanoyuan(item.chargedNanoyuan)}`,
      ),
    );
    if (item.usage)
      entry.append(
        node(
          'p',
          `输入 ${item.usage.promptTokens}（缓存命中 ${item.usage.cacheHitTokens} / 未命中 ${item.usage.cacheMissTokens}）· 输出 ${item.usage.completionTokens} · 总计 ${item.usage.totalTokens} · 价格 ${item.priceVersion} / ${item.pricePeriod ?? '待核对'}`,
          'hint',
        ),
      );
    if (item.pendingReason) entry.append(node('p', `核对原因：${item.pendingReason}`, 'hint'));
    if (item.upstreamId) entry.append(node('p', `上游调用 ID：${item.upstreamId}`, 'hint'));
    callList.append(entry);
  }
  if (!requests.length) callList.append(node('li', '暂无托管调用数据；用户自带 Key 的本机调用不属于此账本。'));
  section.append(
    callList,
    node('p', '显示当前空间最近 50 次托管调用；费用按已记录 usage 和公开价格计算，待核对项不按 0 元结算。', 'hint'),
  );
  content.append(section);
}

function addMembershipControls(content, space, version, plans, billing) {
  const panel = node('div', undefined, 'membership-controls');
  const modeLabel = node('label', '会员办理方式');
  modeLabel.htmlFor = 'membership-mode';
  const mode = node('select');
  mode.id = 'membership-mode';
  for (const [value, label] of [
    ['purchase', '套餐购买／付费续期（管理员确认）'],
    ['gift', '赠送／人工调整'],
  ]) {
    const option = node('option', label);
    option.value = value;
    mode.append(option);
  }
  const purchasePanel = node('div');
  const giftPanel = node('div');
  const cancelPurchase = addPurchaseEditor(purchasePanel, space, version, plans, billing, (pending) => {
    mode.disabled = pending;
  });
  const cancelGift = addMembershipEditor(giftPanel, space, version, (pending) => {
    mode.disabled = pending;
  });
  const activeCustom =
    space.membership?.status === 'active' &&
    !plans.some((plan) => plan.id === space.membership.planId && plan.maxBytes === space.membership.maxBytes);
  mode.value = activeCustom || !billing?.available ? 'gift' : 'purchase';
  const update = () => {
    cancelPurchase();
    cancelGift();
    purchasePanel.hidden = mode.value !== 'purchase';
    giftPanel.hidden = mode.value !== 'gift';
  };
  mode.addEventListener('change', () => {
    if (!mode.disabled) update();
  });
  update();
  panel.append(modeLabel, mode, purchasePanel, giftPanel);
  content.append(panel);
}

function addPurchaseEditor(content, space, version, plans, billing, setCommitPending = () => {}) {
  const form = node('form', undefined, 'editor purchase-editor');
  const feedback = formFeedback(form);
  form.append(node('h3', '套餐购买／付费续期（管理员确认）'));
  const label = node('label', '套餐');
  label.htmlFor = 'purchase-plan';
  const selection = node('select');
  selection.id = 'purchase-plan';
  const options = Array.isArray(plans) ? plans : [];
  for (const plan of options) {
    const option = node(
      'option',
      `${plan.name} · ${plan.durationDays} 天 · ${bytes(plan.maxBytes)} · ${priceText(plan.priceFen)} · 整期 API ${moneyNanoyuan(plan.creditNanoyuan)}（50%）`,
    );
    option.value = plan.id;
    selection.append(option);
  }
  const membership = space.membership;
  const active = membership?.status === 'active';
  selection.value = active && membership.planId ? membership.planId : 'vip-month-256';
  const presets = node('div', undefined, 'presets plan-presets');
  presets.setAttribute('aria-label', 'VIP 套餐快捷选择');
  const planButtons = options.map((plan) => {
    const button = node(
      'button',
      `${plan.name} · ${priceText(plan.priceFen)} / API ${moneyNanoyuan(plan.creditNanoyuan)}`,
      'secondary',
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      selection.value = plan.id;
      updatePlan();
    });
    presets.append(button);
    return button;
  });
  const selectedSummary = node('p', undefined, 'plan-summary');
  const warning = node('p', undefined, 'quota-warning');
  const save = node('button', '预览套餐购买');
  save.type = 'submit';
  const confirmation = node('div', undefined, 'confirmation');
  let editVersion = 0;
  let expiryTimer;
  const clear = () => {
    editVersion++;
    clearTimeout(expiryTimer);
    confirmation.replaceChildren();
  };
  const selected = () => options.find((plan) => plan.id === selection.value);
  const restriction = () => {
    const plan = selected();
    if (!billing?.available) return '服务器托管账本尚未启用，无法购买。';
    if (!plan) return '请选择服务器目录中的套餐。';
    if (active && (!membership.planId || membership.maxBytes !== plan.maxBytes || membership.planId !== plan.id))
      return membership.planId
        ? '有效会员仅支持当前同档付费续期；跨档购买需要另行处理。'
        : '有效的历史自定义会员没有明确套餐身份，请使用赠送／人工调整。';
    return '';
  };
  const updatePlan = () => {
    clear();
    const plan = selected();
    selectedSummary.textContent = plan
      ? `${plan.name}：${plan.durationDays} 天 / ${bytes(plan.maxBytes)}，标价 ${priceText(plan.priceFen)}，整期一次发放 API 额度 ${moneyNanoyuan(plan.creditNanoyuan)}（50%）。`
      : '套餐目录不可用。';
    warning.textContent = restriction();
    warning.hidden = !warning.textContent;
    save.disabled = !!warning.textContent;
    planButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(options[index].id === selection.value));
    });
  };
  selection.addEventListener('change', updatePlan);
  form.append(label, selection, presets, selectedSummary, warning);
  if (space.customQuota)
    form.append(
      node(
        'p',
        `固定配额 ${bytes(space.quotaLimitBytes)} 继续优先，包括 0；购买不会自动取消固定配额。`,
        'quota-warning',
      ),
    );
  form.append(
    node(
      'p',
      '管理员确认只记录本次购买，不能代替收款证明。每次新确认算一笔新购买；整期额度只发放一次，两个年档独立。',
      'hint',
    ),
    node('p', '有效会员按同档续期；到期或撤销后可重新选档。付费资格从当前服务器时间与原付费截止的较晚者延长。', 'hint'),
    save,
    confirmation,
  );
  updatePlan();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (save.disabled) return;
    void perform(async () => {
      clear();
      if (restriction()) throw new Error(restriction());
      const requestVersion = editVersion;
      save.disabled = true;
      feedback.textContent = '预览读取中…';
      try {
        const preview = await api('/api/changes/prepare', {
          spaceHandle: space.spaceHandle,
          membership: { action: 'purchase', planId: selection.value },
        });
        if (version !== detailVersion || requestVersion !== editVersion) return;
        const purchase = preview.purchase;
        if (!purchase) throw new Error('服务器未返回购买快照，请刷新后重新预览。');
        feedback.textContent = '预览已读取，请核对并手动填写完整空间句柄。';
        confirmation.append(
          node('h3', '二次确认套餐购买'),
          node('p', operationNotice(preview), 'hint handle'),
          node(
            'p',
            `${purchase.planName}（${purchase.planId} / ${purchase.planVersion}）· ${purchase.durationDays} 天 · ${bytes(purchase.maxBytes)}`,
          ),
          node(
            'p',
            `标价：${priceText(purchase.priceFen)} · 本次整期 API 发放：${moneyNanoyuan(purchase.creditNanoyuan)}（50%）`,
          ),
          node(
            'p',
            `VIP 到期：${date(preview.before.membership?.expiresAt)} → ${date(preview.after.membership?.expiresAt)}`,
          ),
          node('p', `API 付费资格截止：${date(billing.paidUntil)} → ${date(purchase.paidUntil)}`),
          node('p', `有效容量：${quotaDescription(preview.before)} → ${quotaDescription(preview.after)}`),
          node('p', `目标账户：${preview.after.accountId ?? space.profile.accountId}`),
          node('p', `目标空间：${space.spaceHandle}`, 'handle'),
          node('p', '保存前自动创建一致性备份。管理员确认记录不构成支付平台收款证明。', 'hint'),
          node('p', `确认 2 分钟内有效，截至 ${date(preview.expiresAt)}。请输入完整空间句柄：`),
          handleCopy(space.spaceHandle),
        );
        const handleLabel = node('label', '确认套餐购买的空间句柄');
        handleLabel.htmlFor = 'purchase-confirm-handle';
        const handle = node('input');
        handle.id = 'purchase-confirm-handle';
        handle.autocomplete = 'off';
        handle.spellcheck = false;
        const confirm = node('button', '备份并确认购买');
        confirm.type = 'button';
        confirm.disabled = true;
        const expired = () => Date.now() >= preview.expiresAt;
        handle.addEventListener('input', () => {
          confirm.disabled = handle.value !== space.spaceHandle || expired();
        });
        const cancel = node('button', '取消确认', 'secondary');
        cancel.type = 'button';
        cancel.addEventListener('click', () => {
          clear();
          save.focus();
        });
        expiryTimer = setTimeout(
          () => {
            if (version !== detailVersion || requestVersion !== editVersion) return;
            clear();
            confirmation.append(node('p', '确认已过期，请重新预览套餐购买。', 'hint'));
          },
          Math.max(0, preview.expiresAt - Date.now()),
        );
        confirm.addEventListener(
          'click',
          () =>
            void perform(async () => {
              if (confirm.disabled) return;
              if (version !== detailVersion || requestVersion !== editVersion) return;
              if (expired()) throw new Error('确认已过期，请重新预览套餐购买。');
              if (handle.value !== space.spaceHandle) throw new Error('请输入完整空间句柄。');
              for (const control of [selection, save, handle, confirm, cancel, ...planButtons]) control.disabled = true;
              clearTimeout(expiryTimer);
              feedback.textContent = '保存中…正在备份并提交，请等待结果。';
              setCommitPending(true);
              try {
                const result = await api(
                  '/api/changes/commit',
                  {
                    confirmationId: preview.confirmationId,
                    confirmSpaceHandle: handle.value,
                  },
                  preview,
                );
                await showOperationResult(
                  result,
                  '套餐购买已保存',
                  () => showDetail(space.spaceHandle, 'vip'),
                  version,
                );
                feedback.textContent = byId('operation-result').textContent;
              } finally {
                setCommitPending(false);

                for (const control of [selection, ...planButtons]) control.disabled = false;
                updatePlan();
              }
            }, feedback),
        );
        confirmation.append(handleLabel, handle, confirm, cancel);
        handle.focus();
      } finally {
        save.disabled = !!restriction();
      }
    }, feedback);
  });
  content.append(form);
  return clear;
}

function addMembershipEditor(content, space, version, setCommitPending = () => {}) {
  const form = node('form', undefined, 'editor');
  const feedback = formFeedback(form);
  form.append(node('h3', '赠送／人工调整'));
  form.append(node('p', '本次 API 额度变动为 0，不延长 API 付费资格；撤销只暂停调用，账本余额保留。', 'hint'));
  form.append(node('p', `当前状态：${membershipText(space.membership)}`));
  if (space.customQuota)
    form.append(
      node(
        'p',
        `当前固定配额 ${bytes(space.quotaLimitBytes)} 优先；开通或续期 VIP 不会改变实际容量。需要采用 VIP 额度时，请在“配额”取消固定配额。`,
        'quota-warning',
      ),
    );
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
  const dayPresets = node('div', undefined, 'presets');
  dayPresets.setAttribute('aria-label', '常用会员期限');
  const dayButtons = [30, 90, 365].map((value) => {
    const button = node('button', `${value} 天`, 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      days.value = String(value);
      updateDays();
      clear();
    });
    dayPresets.append(button);
    return button;
  });
  const updateDays = () => {
    dayButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(Number(days.value) === [30, 90, 365][index]));
    });
  };
  updateDays();
  const quotaLabel = node('label', 'VIP 存储容量');
  quotaLabel.htmlFor = 'membership-quota';
  const capacity = capacityControls('membership-quota', space.membership?.maxBytes ?? 1024 ** 3, {
    allowZero: false,
    onChange: () => clear(),
  });
  const fields = node('div');
  fields.append(daysLabel, days, dayPresets, quotaLabel, capacity.container);
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
    capacity.disable(revoke, revoke);
    for (const button of dayButtons) button.disabled = revoke;
    clear();
  };
  action.addEventListener('change', updateAction);
  days.addEventListener('input', () => {
    updateDays();
    clear();
  });
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
    if (save.disabled) return;
    void perform(async () => {
      clear();
      const requestVersion = editVersion;
      save.disabled = true;
      feedback.textContent = '预览读取中…';
      try {
        const membership = { action: action.value };
        if (action.value !== 'revoke') {
          const durationDays = Number(days.value);
          const maxBytes = capacity.value();
          if (days.value.trim() === '' || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)
            throw new Error('有效期须为 1 至 3650 的整数天。');
          membership.durationDays = durationDays;
          membership.maxBytes = maxBytes;
        }
        const preview = await api('/api/changes/prepare', { spaceHandle: space.spaceHandle, membership });
        if (version !== detailVersion || requestVersion !== editVersion) return;
        feedback.textContent = '预览已读取，请核对并手动填写完整空间句柄。';
        confirmation.append(
          node('h3', '二次确认会员变更'),
          node('p', operationNotice(preview), 'hint handle'),
          node('p', '本次 API 额度变动：¥0.00；不延长 API 付费资格。', 'hint'),
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
          handleCopy(space.spaceHandle),
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
        cancel.addEventListener('click', () => {
          clear();
          save.focus();
        });
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
              if (confirm.disabled) return;
              if (version !== detailVersion || requestVersion !== editVersion) return;
              if (expired()) throw new Error('确认已过期，请重新预览会员变更。');
              if (handle.value !== space.spaceHandle) throw new Error('请输入完整空间句柄。');
              confirm.disabled = true;
              cancel.disabled = true;
              for (const control of [action, days, save, handle, ...dayButtons]) control.disabled = true;
              capacity.disable(true, true);
              clearTimeout(expiryTimer);
              feedback.textContent = '保存中…正在备份并提交，请等待结果。';
              setCommitPending(true);
              try {
                const result = await api(
                  '/api/changes/commit',
                  {
                    confirmationId: preview.confirmationId,
                    confirmSpaceHandle: handle.value,
                  },
                  preview,
                );
                await showOperationResult(
                  result,
                  '会员变更已保存',
                  () => showDetail(space.spaceHandle, 'vip'),
                  version,
                );
                feedback.textContent = byId('operation-result').textContent;
              } finally {
                setCommitPending(false);

                action.disabled = false;
                days.disabled = action.value === 'revoke';
                capacity.disable(action.value === 'revoke', action.value === 'revoke');
                for (const button of dayButtons) button.disabled = action.value === 'revoke';
                save.disabled = false;
                clear();
              }
            }, feedback),
        );
        confirmation.append(handleLabel, handle, confirm, cancel);
        handle.focus();
      } finally {
        save.disabled = false;
      }
    }, feedback);
  });
  content.append(form);
  return clear;
}

async function perform(work, feedback) {
  const version = sessionVersion;
  byId('notice').textContent = '';
  if (feedback) feedback.textContent = '';
  try {
    await work();
  } catch (error) {
    if (version === sessionVersion) {
      const message =
        error instanceof Error
          ? error.name === 'TimeoutError'
            ? '请求超时；若刚提交，请刷新核对结果后再试。'
            : error.message
          : '连接失败，请检查 SSH 隧道。';
      byId('notice').textContent = message;
      if (feedback) feedback.textContent = message;
    }
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
byId('refresh').addEventListener('click', () => {
  if (!byId('refresh').disabled) void perform(refresh);
});
byId('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = byId('search').value.trim();
  if (listPending && query === committedQuery && offset === 0) return;
  committedQuery = query;
  offset = 0;
  detailVersion++;
  byId('details').hidden = true;
  void perform(loadList);
});
byId('previous').addEventListener('click', () => {
  if (listPending || byId('previous').disabled) return;
  offset = Math.max(0, displayedOffset - limit);
  void perform(loadList);
});
byId('next').addEventListener('click', () => {
  if (listPending || byId('next').disabled) return;
  offset = displayedOffset + limit;
  void perform(loadList);
});
window.addEventListener('pagehide', logout);
