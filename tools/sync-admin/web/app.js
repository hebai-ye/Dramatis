const byId = (id) => document.getElementById(id);
let token = '';
let sessionVersion = 0;
let offset = 0;
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

function logout() {
  sessionVersion++;
  token = '';
  byId('token').value = '';
  byId('dashboard').hidden = true;
  byId('login').hidden = false;
  byId('details').hidden = true;
  for (const id of ['summary', 'spaces', 'backups', 'detail-content']) byId(id).replaceChildren();
}

async function api(path) {
  const version = sessionVersion;
  const response = await fetch(path, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (version !== sessionVersion) throw new Error('session-ended');
  if (response.status === 401) {
    logout();
    byId('notice').textContent = '管理 token 无效，请重新连接。';
    throw new Error('管理 token 无效，请重新连接。');
  }
  if (!response.ok) throw new Error('管理查询失败，请检查服务与审计文件权限。');
  const result = await response.json();
  if (version !== sessionVersion) throw new Error('session-ended');
  return result;
}

async function showDetail(handle) {
  const detail = await api(`/api/spaces/${encodeURIComponent(handle)}`);
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
  const query = new URLSearchParams({ q: byId('search').value, offset: String(offset), limit: String(limit) });
  const result = await api(`/api/spaces?${query}`);
  const body = byId('spaces');
  body.replaceChildren();
  for (const space of result.spaces) {
    const row = node('tr');
    const profile = node('td');
    profile.append(node('strong', space.profile?.displayName ?? '未认领'));
    if (space.profile) profile.append(node('span', space.profile.accountId, 'account-id'));
    row.append(
      profile,
      node('td', space.spaceHandle, 'handle'),
      node('td', space.records ?? '未知'),
      node('td', bytes(space.quotaBytes)),
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
  const overview = await api('/api/overview');
  const summary = byId('summary');
  summary.replaceChildren();
  const entries = [
    ['已关联账户', overview.profilesAvailable ? overview.accounts : '登记未启用'],
    ['未认领空间', overview.unclaimed],
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
  byId('login').hidden = true;
  byId('dashboard').hidden = false;
}

async function perform(work) {
  const version = sessionVersion;
  byId('notice').textContent = '';
  try {
    await work();
  } catch (error) {
    if (version === sessionVersion)
      byId('notice').textContent = error instanceof Error ? error.message : '连接失败，请检查 SSH 隧道。';
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
