import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');

function adminUi(fetch) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', addEventListener() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const context = createContext({
    document: { getElementById: byId },
    window: { addEventListener() {} },
    fetch,
    AbortSignal,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  });
  runInContext(source, context, { filename: 'tools/sync-admin/web/app.js' });
  return {
    api: runInContext('api', context),
    operationNotice: runInContext('typeof operationNotice === "function" ? operationNotice : undefined', context),
    showOperationResult: runInContext(
      'typeof showOperationResult === "function" ? showOperationResult : undefined',
      context,
    ),
    context,
    byId,
  };
}

const preview = { operationId: 'operation-fixture-7', confirmationId: 'secret-confirmation-ticket' };
const committed = {
  ...preview,
  confirmationHash: 'a'.repeat(64),
  backupFile: 'fixture.sqlite',
  auditWarning: '审计待补写',
};

test('HTTP failure exposes audit correlation fields but never the confirmation ticket', async () => {
  const ui = adminUi(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ message: '保存结果待核验', ...committed }),
  }));
  await assert.rejects(ui.api('/api/changes/commit', { confirmationId: preview.confirmationId }, preview), (error) => {
    assert.match(error.message, /operation-fixture-7/);
    assert.ok(error.message.includes(committed.confirmationHash));
    assert.match(error.message, /保存结果待核验/);
    assert.ok(!error.message.includes(preview.confirmationId));
    return true;
  });
});

test('commit timeout retains the prepared operation id and asks to verify rather than resubmit', async () => {
  const ui = adminUi(async () => {
    const error = new Error('timeout');
    error.name = 'TimeoutError';
    throw error;
  });
  await assert.rejects(ui.api('/api/changes/commit', { confirmationId: preview.confirmationId }, preview), (error) => {
    assert.match(error.message, /operation-fixture-7/);
    assert.match(error.message, /核对|核验/);
    assert.ok(!error.message.includes(preview.confirmationId));
    return true;
  });
});

test('a dropped commit connection also retains its prepared id', async () => {
  const ui = adminUi(async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    ui.api('/api/changes/commit', { confirmationId: preview.confirmationId }, preview),
    /operation-fixture-7/,
  );
});

test('a commit response body failure preserves the operation id after HTTP headers arrive', async () => {
  const ui = adminUi(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('body interrupted');
    },
  }));
  await assert.rejects(ui.api('/api/changes/commit', { confirmationId: preview.confirmationId }, preview), (error) => {
    assert.match(error.message, /operation-fixture-7/);
    assert.match(error.message, /结果尚未确认/);
    assert.ok(!error.message.includes(preview.confirmationId));
    return true;
  });
});

test('preview and successful notices show operation id and hash without disclosing a ticket', () => {
  const ui = adminUi();
  assert.equal(typeof ui.operationNotice, 'function');
  assert.match(ui.operationNotice(preview), /operation-fixture-7/);
  assert.ok(!ui.operationNotice(preview).includes(preview.confirmationId));
  assert.ok(ui.operationNotice(committed).includes(committed.confirmationHash));
  assert.equal(ui.operationNotice({}), '');
});

test('a failed refresh after successful commit preserves applied result, backup, warning and correlation', async () => {
  const ui = adminUi();
  assert.equal(typeof ui.showOperationResult, 'function');
  runInContext('refresh = async () => { throw new Error("read refresh failed"); }', ui.context);
  await ui.showOperationResult(committed, '会员变更已保存', async () => {});
  const notice = ui.byId('notice').textContent;
  for (const text of [
    '会员变更已保存',
    'fixture.sqlite',
    '审计待补写',
    preview.operationId,
    committed.confirmationHash,
    'read refresh failed',
  ]) {
    assert.ok(notice.includes(text), text);
  }
  assert.ok(!notice.includes(preview.confirmationId));
});

test('an old operation refresh cannot overwrite the next admin session notice', async () => {
  const ui = adminUi();
  assert.equal(typeof ui.showOperationResult, 'function');
  runInContext(
    'refresh = async () => { sessionVersion++; document.getElementById("notice").textContent = "new session"; }',
    ui.context,
  );
  let detailReads = 0;
  await ui.showOperationResult(committed, '修改已保存', async () => {
    detailReads++;
  });
  assert.equal(ui.byId('notice').textContent, 'new session');
  assert.equal(detailReads, 0);
});

test('opening another space while a saved operation refreshes prevents reopening its old detail', async () => {
  const ui = adminUi();
  runInContext('refresh = async () => { detailVersion++; await Promise.resolve(); detailVersion++; }', ui.context);
  let detailReads = 0;
  await ui.showOperationResult(committed, '修改已保存', async () => {
    detailReads++;
  });
  assert.equal(detailReads, 0);
  assert.match(ui.byId('notice').textContent, /operation-fixture-7/);
});

test('a successful commit still shows its audit correlation after another detail is selected', async () => {
  class Element {
    constructor(tag = 'div', text = '') {
      this.tag = tag;
      this.textContent = text;
      this.children = [];
      this.listeners = {};
      this.value = '';
      this.checked = false;
      this.disabled = false;
    }
    addEventListener(name, callback) {
      this.listeners[name] ??= [];
      this.listeners[name].push(callback);
    }
    setAttribute() {}
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    select() {}
    fire(name) {
      for (const callback of this.listeners[name] ?? []) callback({ preventDefault() {} });
    }
  }

  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let resolvePrepared;
  const prepared = new Promise((resolve) => {
    resolvePrepared = resolve;
  });
  let resolveCommitStarted;
  const commitStarted = new Promise((resolve) => {
    resolveCommitStarted = resolve;
  });
  let resolveCommit;
  const commit = new Promise((resolve) => {
    resolveCommit = resolve;
  });
  const calls = [];
  const context = createContext({
    document: {
      getElementById: byId,
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => new Element('text', text),
    },
    window: { addEventListener() {} },
    fetch: async (path) => {
      calls.push(path);
      if (path === '/api/changes/prepare') {
        return {
          ok: true,
          status: 200,
          json: async () => {
            resolvePrepared();
            return {
              ...preview,
              expiresAt: Date.now() + 120_000,
              before: { accountId: 'account-a', displayName: 'A', quotaLimitBytes: 1000 },
              after: { accountId: 'account-a', displayName: 'A', quotaLimitBytes: 2000 },
            };
          },
        };
      }
      if (path === '/api/changes/commit') {
        resolveCommitStarted();
        await commit;
        return { ok: true, status: 200, json: async () => committed };
      }
      throw new Error(`Unexpected request after selecting another detail: ${path}`);
    },
    AbortSignal,
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout() {},
  });
  runInContext(source, context, { filename: 'tools/sync-admin/web/app.js' });
  runInContext('detailVersion = 1; editingEnabled = true;', context);
  const content = new Element();
  runInContext('addEditor', context)(
    content,
    {
      spaceHandle: 'space-a',
      profile: { accountId: 'account-a', displayName: 'A' },
      customQuota: true,
      quotaLimitBytes: 1000,
    },
    1,
  );
  content.children[0].fire('submit');
  await prepared;
  await new Promise((resolve) => setImmediate(resolve));
  const descendants = (element) => [element, ...element.children.flatMap(descendants)];
  const handle = descendants(content).find((element) => element.id === 'confirm-handle');
  const confirm = descendants(content).find((element) => element.textContent === '备份并保存');
  assert.ok(handle);
  assert.ok(confirm);
  handle.value = 'space-a';
  handle.fire('input');
  confirm.fire('click');
  await commitStarted;

  // showDetail increments this generation as soon as a different row is selected.
  runInContext('detailVersion++;', context);
  resolveCommit();
  await new Promise((resolve) => setImmediate(resolve));

  const notice = byId('notice').textContent;
  for (const text of [
    '修改已保存',
    committed.backupFile,
    committed.auditWarning,
    committed.operationId,
    committed.confirmationHash,
  ]) {
    assert.ok(notice.includes(text), `Missing saved-operation detail: ${text}`);
  }
  assert.ok(!notice.includes(preview.confirmationId));
  assert.deepEqual(calls, ['/api/changes/prepare', '/api/changes/commit']);
  assert.equal(runInContext('detailVersion', context), 2);
});
