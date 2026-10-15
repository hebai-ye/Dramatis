import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const ok = (value) => ({ ok: true, status: 200, json: async () => value });
function adminUi(
  fetch = async () => {
    throw new Error('unexpected fetch');
  },
) {
  const ids = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let activeElement;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.value = '';
      this.ownText = '';
      this.disabled = false;
      this.hidden = false;
    }
    set textContent(value) {
      this.ownText = String(value);
      this.children = [];
    }
    get textContent() {
      return this.ownText + this.children.map((child) => child.textContent).join(' ');
    }
    addEventListener(name, callback) {
      this.listeners[name] ??= [];
      this.listeners[name].push(callback);
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.ownText = '';
      this.children = [...children];
    }
    after(element) {
      this.children.push(element);
    }
    querySelector(tag) {
      return descendants(this).find((element) => element.tagName === tag);
    }
    focus() {
      activeElement = this;
    }
    select() {
      activeElement = this;
    }
    scrollIntoView() {}
    fire(name) {
      for (const callback of this.listeners[name] ?? []) callback({ preventDefault() {} });
    }
  }
  function descendants(element) {
    return element.children.flatMap((child) => [child, ...descendants(child)]);
  }
  function byId(id) {
    const child = [...ids.values()].flatMap(descendants).find((element) => element.id === id);
    if (child) return child;
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  }
  byId('details').append(new Element('h2'));
  const copied = [];
  const context = createContext({
    document: {
      getElementById: byId,
      createElement: (tag) => new Element(tag),
      createTextNode: (value) => {
        const e = new Element('text');
        e.textContent = value;
        return e;
      },
    },
    window: { addEventListener() {} },
    navigator: {
      clipboard: {
        writeText: async (value) => {
          copied.push(value);
        },
      },
    },
    fetch,
    AbortSignal,
    URLSearchParams,
    setTimeout: (callback) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  runInContext(source, context);
  return {
    byId,
    context,
    copied,
    timers,
    run: (script) => runInContext(script, context),
    descendants,
    get activeElement() {
      return activeElement;
    },
  };
}
const space = {
  spaceHandle: 'fixture-space-full-handle',
  profile: { accountId: 'fixture-owner', displayName: 'Fixture' },
  quotaLimitBytes: 1024 ** 3,
  quotaSource: 'default',
  membershipsAvailable: true,
};
const plan = {
  id: 'vip-month-256',
  name: 'Fixture plan',
  version: 'v1',
  durationDays: 30,
  maxBytes: 256 * 1024 ** 2,
  priceFen: 1000,
  creditNanoyuan: '5000000000',
};
const preview = {
  operationId: 'fixture-operation-id',
  confirmationId: 'secret-ticket',
  expiresAt: Date.now() + 120000,
  before: { ...space },
  after: { ...space, accountId: space.profile.accountId },
  purchase: {
    ...plan,
    planName: plan.name,
    planId: plan.id,
    planVersion: plan.version,
    paidUntil: Date.now() + 500000,
  },
};
const billing = { available: true, purchases: [], requests: [], availableNanoyuan: '5000000000' };
function find(ui, id, predicate) {
  return ui.descendants(ui.byId(id)).find(predicate);
}
function button(ui, text) {
  return find(ui, 'detail-content', (element) => element.tagName === 'button' && element.textContent === text);
}
function mountEditor(ui, kind) {
  ui.run('detailVersion = 1');
  ui.context.fixtureSpace = space;
  ui.context.fixturePreview = preview;
  ui.context.fixturePlans = [plan];
  ui.context.fixtureBilling = billing;
  ui.run(
    kind === 'quota'
      ? 'addEditor(document.getElementById("detail-content"), fixtureSpace, 1)'
      : 'addMembershipControls(document.getElementById("detail-content"), fixtureSpace, 1, fixturePlans, fixtureBilling)',
  );
  if (kind === 'gift') {
    ui.byId('membership-mode').value = 'gift';
    ui.byId('membership-mode').fire('change');
  }
  return find(
    ui,
    'detail-content',
    (element) =>
      element.tagName === 'form' &&
      (kind === 'quota' ||
        (kind === 'purchase'
          ? element.className?.includes('purchase-editor')
          : !element.className?.includes('purchase-editor'))),
  );
}

test('similar purchase rows retain distinct copyable operation ids across repeated detail rendering', async () => {
  const ui = adminUi();
  ui.context.fixtureBilling = {
    ...billing,
    purchases: [
      { ...preview.purchase, operationId: 'fixture-operation-a'.repeat(8), confirmationId: 'secret-ticket' },
      { ...preview.purchase, operationId: 'fixture-operation-b' },
      { ...preview.purchase },
    ],
  };
  for (let pass = 0; pass < 2; pass++) {
    ui.byId('detail-content').replaceChildren();
    ui.run('addBillingDetail(document.getElementById("detail-content"), fixtureBilling)');
    const content = ui.byId('detail-content');
    assert.match(content.textContent, /fixture-operation-a/);
    assert.match(content.textContent, /fixture-operation-b/);
    assert.match(content.textContent, /操作编号.*未知|未知.*操作编号/);
    assert.ok(!content.textContent.includes('secret-ticket'));
    const copy = find(
      ui,
      'detail-content',
      (element) => element.tagName === 'button' && element.textContent === '复制操作编号',
    );
    assert.ok(copy, 'history offers operation id copy');
    copy.fire('click');
    await tick();
    assert.equal(ui.copied.at(-1), 'fixture-operation-a'.repeat(8));
  }
});

test('pagination uses submitted search and ignores later search draft', async () => {
  const paths = [];
  const ui = adminUi(async (path) => {
    paths.push(path);
    return ok({ spaces: [], total: 150 });
  });
  ui.byId('search').value = 'submitted';
  ui.byId('search-form').fire('submit');
  await tick();
  ui.byId('search').value = 'draft';
  ui.byId('next').fire('click');
  await tick();
  const query = new URL(paths.at(-1), 'http://fixture').searchParams;
  assert.equal(query.get('q'), 'submitted');
  assert.equal(query.get('offset'), '50');
});

test('slow pagination locks repeated clicks and newest search wins over old response', async () => {
  const first = deferred();
  const second = deferred();
  const paths = [];
  const ui = adminUi(async (path) => {
    paths.push(path);
    return paths.length === 1 ? first.promise : second.promise;
  });
  ui.byId('search').value = 'old';
  ui.byId('search-form').fire('submit');
  assert.equal(ui.byId('next').disabled, true);
  assert.equal(ui.byId('previous').disabled, true);
  ui.byId('next').fire('click');
  ui.byId('next').fire('click');
  assert.equal(paths.length, 1);
  ui.byId('search').value = 'new';
  ui.byId('search-form').fire('submit');
  assert.equal(new URL(paths.at(-1), 'http://fixture').searchParams.get('offset'), '0');
  second.resolve(ok({ spaces: [{ ...space, spaceHandle: 'new-result' }], total: 1 }));
  await tick();
  first.resolve(ok({ spaces: [{ ...space, spaceHandle: 'old-result' }], total: 1 }));
  await tick();
  assert.match(ui.byId('spaces').textContent, /new-result/);
  assert.ok(!ui.byId('spaces').textContent.includes('old-result'));
});

test('a shrinking result set returns an invalid page to the first page', async () => {
  const paths = [];
  const ui = adminUi(async (path) => {
    paths.push(path);
    return ok({ spaces: [], total: paths.length === 1 ? 100 : 2 });
  });
  await ui.run('loadList()');
  ui.byId('next').fire('click');
  await tick();
  assert.equal(paths.length, 3);
  assert.equal(new URL(paths.at(-1), 'http://fixture').searchParams.get('offset'), '0');
  assert.equal(ui.byId('previous').disabled, true);
});

test('list feedback retains successful read time and snapshot when a later request fails', async () => {
  const wait = deferred();
  let count = 0;
  const ui = adminUi(async () => {
    if (++count === 1) return ok({ spaces: [space], total: 100 });
    return wait.promise;
  });
  await ui.run('loadList()');
  assert.match(ui.byId('list-status').textContent, /最近.*读取/);
  ui.byId('next').fire('click');
  assert.match(ui.byId('list-status').textContent, /读取中|加载中/);
  wait.resolve({ ok: false, status: 503, json: async () => ({ message: 'fixture-read-error' }) });
  await tick();
  assert.match(ui.byId('list-status').textContent, /fixture-read-error/);
  assert.match(ui.byId('list-status').textContent, /最近.*读取/);
  assert.match(ui.byId('spaces').textContent, /fixture-space-full-handle/);
  assert.equal(ui.byId('previous').disabled, true, 'failed next page leaves the displayed page unchanged');
  assert.equal(ui.byId('next').disabled, false);
});

for (const kind of ['quota', 'purchase', 'gift']) {
  test(`${kind} preview focuses manual confirmation and cancellation returns to preview`, async () => {
    const ui = adminUi(async () => ok(preview));
    const form = mountEditor(ui, kind);
    form.fire('submit');
    await tick();
    const id =
      kind === 'quota'
        ? 'confirm-handle'
        : kind === 'purchase'
          ? 'purchase-confirm-handle'
          : 'membership-confirm-handle';
    assert.equal(ui.activeElement, ui.byId(id));
    button(ui, '取消确认').fire('click');
    assert.equal(
      ui.activeElement,
      button(ui, kind === 'quota' ? '预览修改' : kind === 'purchase' ? '预览套餐购买' : '预览会员变更'),
    );
    assert.equal(
      find(ui, 'detail-content', (element) => element.id === id),
      undefined,
    );
  });
  test(`${kind} failed preview displays feedback next to its form`, async () => {
    const ui = adminUi(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ message: 'fixture-preview-error' }),
    }));
    const form = mountEditor(ui, kind);
    form.fire('submit');
    await tick();
    assert.match(form.textContent, /fixture-preview-error/);
  });
  test(`${kind} expiry announces that a new preview is required`, async () => {
    const ui = adminUi(async () => ok(preview));
    const form = mountEditor(ui, kind);
    form.fire('submit');
    await tick();
    for (const callback of [...ui.timers.values()]) callback();
    assert.match(form.textContent, /确认已过期/);
  });
}

for (const kind of ['purchase', 'gift']) {
  test(`${kind} commit protects membership mode and retains uncertain correlation locally`, async () => {
    const commit = deferred();
    const calls = [];
    const ui = adminUi(async (path) => {
      calls.push(path);
      if (path === '/api/changes/prepare') return ok(preview);
      return commit.promise;
    });
    const form = mountEditor(ui, kind);
    form.fire('submit');
    await tick();
    const handle = ui.byId(kind === 'purchase' ? 'purchase-confirm-handle' : 'membership-confirm-handle');
    handle.value = space.spaceHandle;
    handle.fire('input');
    button(ui, kind === 'purchase' ? '备份并确认购买' : '备份并保存会员变更').fire('click');
    assert.equal(ui.byId('membership-mode').disabled, true);
    assert.match(form.textContent, /保存中|提交中/);
    commit.resolve({
      ok: false,
      status: 503,
      json: async () => ({ message: '结果尚未确认', operationId: preview.operationId }),
    });
    await tick();
    assert.equal(ui.byId('membership-mode').disabled, false);
    assert.match(form.textContent, /fixture-operation-id/);
    assert.match(ui.byId('operation-result').textContent, /fixture-operation-id/);
    ui.byId('membership-mode').value = kind === 'purchase' ? 'gift' : 'purchase';
    ui.byId('membership-mode').fire('change');
    assert.match(ui.byId('operation-result').textContent, /fixture-operation-id/);
    assert.ok(!ui.byId('operation-result').textContent.includes('secret-ticket'));
    assert.deepEqual(calls, ['/api/changes/prepare', '/api/changes/commit']);
  });
}

test('successful operation feedback survives independent list reads and failed detail refresh', async () => {
  const ui = adminUi(async () => ok({ spaces: [], total: 0 }));
  ui.run('refresh = async () => { throw new Error("fixture-refresh-error"); }');
  ui.context.fixtureResult = { operationId: 'saved-operation', backupFile: 'fixture.sqlite' };
  await ui.run('showOperationResult(fixtureResult, "已保存", async () => {})');
  ui.byId('search-form').fire('submit');
  await tick();
  assert.match(ui.byId('operation-result').textContent, /saved-operation/);
  assert.match(ui.byId('operation-result').textContent, /已保存.*fixture-refresh-error/);
});

test('repeating the same pending search does not duplicate its request', async () => {
  const pending = deferred();
  let reads = 0;
  const ui = adminUi(async () => {
    reads++;
    return pending.promise;
  });
  ui.byId('search').value = 'same';
  ui.byId('search-form').fire('submit');
  ui.byId('search-form').fire('submit');
  assert.equal(reads, 1);
  pending.resolve(ok({ spaces: [], total: 0 }));
  await tick();
});

test('a failed new filter keeps the old snapshot but prevents paging it as the new query', async () => {
  let reads = 0;
  const ui = adminUi(async () =>
    ++reads === 1
      ? ok({ spaces: [space], total: 100 })
      : { ok: false, status: 503, json: async () => ({ message: 'new-filter-failed' }) },
  );
  await ui.run('loadList()');
  ui.byId('search').value = 'new-filter';
  ui.byId('search-form').fire('submit');
  await tick();
  assert.match(ui.byId('spaces').textContent, /fixture-space-full-handle/);
  assert.equal(ui.byId('next').disabled, true);
  ui.byId('next').fire('click');
  await tick();
  assert.equal(reads, 2);
});

for (const kind of ['quota', 'purchase', 'gift']) {
  test(`${kind} saved result replaces local saving text when refresh fails`, async () => {
    const ui = adminUi(async (path) =>
      path === '/api/changes/prepare'
        ? ok(preview)
        : ok({ operationId: 'saved-operation-local', backupFile: 'fixture.sqlite' }),
    );
    ui.run('refresh = async () => { throw new Error("fixture-refresh-error"); }');
    const form = mountEditor(ui, kind);
    form.fire('submit');
    await tick();
    const handle = ui.byId(
      kind === 'quota'
        ? 'confirm-handle'
        : kind === 'purchase'
          ? 'purchase-confirm-handle'
          : 'membership-confirm-handle',
    );
    handle.value = space.spaceHandle;
    handle.fire('input');
    button(ui, kind === 'quota' ? '备份并保存' : kind === 'purchase' ? '备份并确认购买' : '备份并保存会员变更').fire(
      'click',
    );
    await tick();
    assert.match(form.textContent, /saved-operation-local/);
    assert.match(form.textContent, /已保存.*fixture-refresh-error/);
    assert.ok(!form.textContent.includes('保存中…'));
  });
}

test('read-only detail loads locally, rejects stale detail data, and preserves operation feedback', async () => {
  const first = deferred();
  const paths = [];
  const detail = (handle) => ({
    space: { ...space, spaceHandle: handle },
    collections: [],
    devices: [],
    membershipHistory: [],
    deviceCount: 0,
    ciphertextJsonBytes: 0,
    apiBilling: billing,
  });
  const ui = adminUi(async (path) => {
    paths.push(path);
    return paths.length === 1 ? first.promise : ok(detail('latest-detail'));
  });
  ui.byId('operation-result').textContent = 'saved-operation';
  const oldRead = ui.run('showDetail("old-detail")');
  assert.equal(ui.byId('details').hidden, false);
  assert.match(ui.byId('detail-status').textContent, /读取中/);
  await ui.run('showDetail("latest-detail")');
  first.resolve(ok(detail('old-detail')));
  await oldRead;
  assert.match(ui.byId('detail-content').textContent, /latest-detail/);
  assert.ok(!ui.byId('detail-content').textContent.includes('old-detail'));
  assert.match(ui.byId('detail-status').textContent, /最近.*读取/);
  assert.equal(
    find(ui, 'detail-content', (element) => element.tagName === 'form'),
    undefined,
  );
  assert.deepEqual(paths, ['/api/spaces/old-detail', '/api/spaces/latest-detail']);
  assert.equal(ui.byId('operation-result').textContent, 'saved-operation');
});

test('overview refresh locks repeat reads and reports a failure near the overview', async () => {
  const pending = deferred();
  let reads = 0;
  const ui = adminUi(async () => {
    reads++;
    return pending.promise;
  });
  ui.byId('refresh').fire('click');
  assert.equal(ui.byId('refresh').disabled, true);
  assert.match(ui.byId('overview-status').textContent, /读取中/);
  ui.byId('refresh').fire('click');
  assert.equal(reads, 1);
  pending.resolve({ ok: false, status: 503, json: async () => ({ message: 'fixture-overview-error' }) });
  await tick();
  assert.match(ui.byId('overview-status').textContent, /fixture-overview-error/);
  assert.equal(ui.byId('refresh').disabled, false);
});

test('a failed reread of the same detail retains its last successful read time', async () => {
  let reads = 0;
  const ui = adminUi(async () =>
    ++reads === 1
      ? ok({
          space,
          collections: [],
          devices: [],
          membershipHistory: [],
          deviceCount: 0,
          ciphertextJsonBytes: 0,
          apiBilling: billing,
        })
      : { ok: false, status: 503, json: async () => ({ message: 'fixture-detail-error' }) },
  );
  await ui.run('showDetail("fixture-space-full-handle")');
  await assert.rejects(ui.run('showDetail("fixture-space-full-handle")'));
  assert.match(ui.byId('detail-status').textContent, /fixture-detail-error/);
  assert.match(ui.byId('detail-status').textContent, /最近.*读取/);
});
