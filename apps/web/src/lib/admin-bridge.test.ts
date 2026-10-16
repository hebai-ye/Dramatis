import {
  createBlankCard,
  createConversation,
  createMemoryEntityStore,
  createSceneFor,
  Repository,
  type Room,
  roomId,
} from '@dramatis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminChat } from './admin';
import { adminProcessStore } from './admin-process-store';
import type { DramatisDb } from './db';
import type { ProvidersApi } from './providers';
import type { SessionApi } from './session';
import { getStreamState, resetStreamState, setStreamState } from './stream-store';

const host = vi.hoisted(() => {
  let cells: unknown[] = [];
  let cursor = 0;
  return {
    state(initial: unknown) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [
        cells[i],
        (next: unknown) => {
          cells[i] = typeof next === 'function' ? next(cells[i]) : next;
        },
      ];
    },
    ref(initial: unknown) {
      const i = cursor++;
      cells[i] ??= { current: initial };
      return cells[i];
    },
    begin() {
      cursor = 0;
    },
    reset() {
      cells = [];
      cursor = 0;
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: host.state,
  useRef: host.ref,
  useCallback: (value: unknown) => value,
  useMemo: (run: () => unknown) => run(),
  useEffect: () => {},
}));

function render(options: Parameters<typeof useAdminChat>[0]) {
  host.begin();
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled hook host executes the actual hook with dependency-light lifecycle.
  return useAdminChat(options);
}
beforeEach(() => {
  host.reset();
  resetStreamState('admin');
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const repository = new Repository(createMemoryEntityStore());
  const world: Room = {
    id: roomId('admin-world-a'),
    title: 'A',
    personaId: null,
    playerName: 'Player',
    playerPersona: '',
    cardIds: [],
    instanceIds: [],
    worldBookIds: [],
    activeConversationId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  };
  const side = createConversation({ roomId: world.id, kind: 'side', title: 'Admin' });
  const main = createConversation({ roomId: world.id, title: 'Main' });
  const scene = createSceneFor(world.id, main.id, [], { location: 'original' });
  await repository.saveRoom(world);
  await repository.saveConversation(side);
  await repository.saveConversation({ ...main, activeSceneId: scene.id });
  await repository.saveScene(scene);
  const session = {
    world,
    conversation: side,
    conversations: [side, { ...main, activeSceneId: scene.id }],
    messages: [],
    instances: [],
    personas: [],
    library: { cards: [], worldBooks: [] },
    appendMessages: vi.fn(async (messages, onPersisted) => {
      await repository.appendMessages(world.id, messages);
      onPersisted?.();
    }),
    setWorldScene: vi.fn(async (patch) => {
      const next = { ...scene, ...patch };
      await repository.saveScene(next);
      return next;
    }),
    reloadWorld: vi.fn(async () => {}),
  } as unknown as SessionApi;
  const options = {
    db: { repository } as DramatisDb,
    session,
    providers: { active: { model: 'fake' }, apiKey: '' } as unknown as ProvidersApi,
    onChanged: vi.fn(),
    accountKey: 'account-a',
  };
  return { repository, world, side, scene, options };
}

describe('副桥接来源和发送等待', () => {
  it('A 结束前切 B，结束后回 A 不恢复旧 busy', async () => {
    const f = await fixture(),
      original = f.options.session;
    let release!: () => void;
    f.options.session = {
      ...original,
      appendMessages: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    };
    const pending = render(f.options).send('delayed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.options.session = { ...original, world: { ...f.world, id: roomId('world-b') } };
    render(f.options);
    release();
    await pending;
    f.options.session = original;
    expect(render(f.options).busy).toBe(false);
  });
  it('切来源立即隐藏旧正文，旧结束不清新流，返回原来源不永久 busy', async () => {
    const f = await fixture(),
      original = f.options.session;
    let release!: () => void;
    f.options.session = {
      ...original,
      appendMessages: () =>
        new Promise<void>((done) => {
          release = done;
        }),
    };
    const pending = render(f.options).send('delayed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setStreamState('admin', { text: '只属于 A', phase: 'writing' });
    f.options.session = { ...original, world: { ...f.world, id: roomId('world-b') } };
    expect(render(f.options).busy).toBe(false);
    expect(getStreamState('admin').text).toBe('');
    setStreamState('admin', { text: 'B 的新正文', phase: 'writing' });
    release();
    await pending;
    expect(getStreamState('admin').text).toBe('B 的新正文');
    f.options.session = original;
    expect(render(f.options).busy).toBe(false);
    expect(render(f.options).canStop).toBe(false);
  });
  it('API 场景部分写入后停止后续工具和模型请求，保存部分结果并先核对', async () => {
    const f = await fixture();
    f.options.providers = {
      active: { baseUrl: 'http://synthetic.invalid/v1', model: 'fake' },
      apiKey: 'synthetic-only',
    } as ProvidersApi;
    Object.assign(f.options.db, { ledger: { record: vi.fn(async () => {}) } });
    const setScene = vi.fn<SessionApi['setWorldScene']>(async (_patch, _target, _room, onEffect) => {
      if (!f.scene.conversationId) throw new Error('fixture must have a main conversation');
      onEffect?.({
        scene: f.scene,
        sceneWritten: true,
        activeLinked: false,
        target: {
          roomId: f.world.id,
          worldTitle: 'A',
          conversationId: f.scene.conversationId,
          conversationTitle: 'Main',
          sceneId: f.scene.id,
          sceneTitle: f.scene.title,
        },
      });
      throw new Error('Synthetic link receipt lost');
    });
    f.options.session.setWorldScene = setScene;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const message =
        request.messages.at(-1)?.role === 'tool'
          ? { content: '结束' }
          : {
              content: '',
              tool_calls: [
                {
                  id: 'scene',
                  type: 'function',
                  function: { name: 'set_scene', arguments: '{"location":"synthetic"}' },
                },
                {
                  id: 'scene-retry',
                  type: 'function',
                  function: { name: 'set_scene', arguments: '{"location":"must-not-write"}' },
                },
              ],
            };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetch);
    await render(f.options).send('scene');
    const api = render(f.options);
    if (!api.processScope || !api.activeRunId) throw new Error('missing run');
    expect(adminProcessStore.get(api.processScope, { runId: api.activeRunId })?.phase).toBe('uncertain');
    expect(setScene).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const output = (await f.repository.listMessages(f.world.id)).find((m) => m.role === 'admin');
    expect(output?.artifacts?.[0]).toMatchObject({ kind: 'scene', status: 'pending', targetId: f.scene.id });
    const count = fetch.mock.calls.length;
    expect((await api.send('scene again')).status).toBe('uncertain');
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it('同账户切换副对话后保留已生成但未保存的草稿，旧运行不污染新正文', async () => {
    const f = await fixture(),
      original = f.options.session;
    f.options.providers = {
      active: { baseUrl: 'http://synthetic.invalid/v1', model: 'fake' },
      apiKey: 'synthetic-only',
    } as ProvidersApi;
    Object.assign(f.options.db, { ledger: { record: vi.fn(async () => {}) } });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      if (fetch.mock.calls.length === 1)
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'draft',
                      type: 'function',
                      function: {
                        name: 'upsert_character_card',
                        arguments: '{"name":"切换前的草稿","description":"合成内容"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      started();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('synthetic aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetch);
    const api = render(f.options),
      scope = api.processScope;
    const pending = api.send('draft');
    await waiting;
    const runId = render(f.options).activeRunId;
    f.options.session = { ...original, conversation: { ...f.side, id: 'other-side' as typeof f.side.id } };
    render(f.options);
    setStreamState('admin', { text: '新副对话正文', phase: 'writing' });
    await pending;
    expect(getStreamState('admin').text).toBe('新副对话正文');
    if (!scope || !runId) throw new Error('missing original run');
    expect(adminProcessStore.get(scope, { runId })?.unsaved?.artifacts[0]?.title).toBe('切换前的草稿');
    f.options.session = original;
    expect(render(f.options).activeRunId).toBe(runId);
    expect(render(f.options).busy).toBe(false);
  });
  it('只读核对确认场景未关联后说明部分结果并解除等待，不重放写入', async () => {
    const f = await fixture();
    const mainId = f.scene.conversationId;
    if (!mainId) throw new Error('missing main');
    const main = await f.repository.getConversation(mainId);
    if (!main) throw new Error('missing main');
    await f.repository.saveConversation({ ...main, activeSceneId: null });
    const next = createSceneFor(f.world.id, main.id, [], { location: 'partial' });
    f.options.providers = {
      active: { baseUrl: 'http://synthetic.invalid/v1', model: 'fake' },
      apiKey: 'synthetic-only',
    } as ProvidersApi;
    Object.assign(f.options.db, { ledger: { record: vi.fn(async () => {}) } });
    f.options.session.setWorldScene = async (_patch, _target, _room, onEffect) => {
      await f.repository.saveScene(next);
      onEffect?.({
        scene: next,
        sceneWritten: true,
        activeLinked: false,
        target: {
          roomId: f.world.id,
          worldTitle: 'A',
          conversationId: main.id,
          conversationTitle: main.title,
          sceneId: next.id,
          sceneTitle: next.title,
        },
      });
      throw new Error('link write failed');
    };
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'partial',
                      type: 'function',
                      function: { name: 'set_scene', arguments: '{"location":"partial"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await render(f.options).send('scene');
    const api = render(f.options);
    const saveScene = vi.spyOn(f.repository, 'saveScene'),
      saveConversation = vi.spyOn(f.repository, 'saveConversation');
    expect((await api.inspectRun()).status).toBe('confirmed');
    const settled = render(f.options);
    expect(settled.needsInspection).toBe(false);
    if (!settled.processScope || !settled.activeRunId) throw new Error('missing run');
    const run = adminProcessStore.get(settled.processScope, { runId: settled.activeRunId });
    expect(run?.phase).toBe('partial');
    expect(run?.issue?.text).toContain('未设为当前场景');
    expect(saveScene).not.toHaveBeenCalled();
    expect(saveConversation).not.toHaveBeenCalled();
    expect((await f.repository.getConversation(main.id))?.activeSceneId).toBeNull();
  });
  it('API 输出回执未知保留正文并只读恢复，不重放模型', async () => {
    const f = await fixture(),
      append = f.options.session.appendMessages;
    f.options.providers = {
      active: { baseUrl: 'http://synthetic.invalid/v1', model: 'fake' },
      apiKey: 'synthetic-only',
    } as ProvidersApi;
    Object.assign(f.options.db, { ledger: { record: vi.fn(async () => {}) } });
    f.options.session.appendMessages = async (messages, onPersisted) => {
      await append(messages, onPersisted);
      if (messages[0]?.role === 'admin') throw new Error('Synthetic receipt lost');
    };
    vi.spyOn(f.repository, 'readAdminMessage').mockRejectedValueOnce(new Error('Synthetic read unavailable'));
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '需保留的正文' } }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await render(f.options).send('once');
    const api = render(f.options);
    expect((await api.send('repeat')).status).toBe('uncertain');
    expect(fetch).toHaveBeenCalledOnce();
    expect((await api.inspectRun()).status).toBe('confirmed');
    expect(fetch).toHaveBeenCalledOnce();
    expect((await f.repository.listMessages(f.world.id)).filter((m) => m.role === 'admin')).toHaveLength(1);
  });
  it('提交回执丢失时禁止重放，核对只读取原消息', async () => {
    const f = await fixture();
    await render(f.options).send('prepare');
    const atomic = f.repository.atomic.bind(f.repository);
    let writes = 0;
    vi.spyOn(f.repository, 'atomic').mockImplementation(async (run) => {
      const result = await atomic(run);
      writes++;
      if (writes === 2) throw new Error('Synthetic receipt lost');
      return result;
    });
    vi.spyOn(f.repository, 'readAdminMessage').mockRejectedValueOnce(new Error('Synthetic read unavailable'));
    const raw = '{"tool":"set_scene","arguments":{"location":"once"}}';
    expect((await render(f.options).commitBridge(raw)).status).toBe('uncertain');
    render(f.options).cancelBridge();
    expect(render(f.options).bridge).not.toBeNull();
    expect((await render(f.options).commitBridge(raw)).status).toBe('uncertain');
    expect(writes).toBe(2);
    expect((await render(f.options).inspectBridge()).status).toBe('confirmed');
    expect(writes).toBe(2);
    expect((await f.repository.listMessages(f.world.id)).filter((m) => m.role === 'admin')).toHaveLength(1);
  });
  it('内容已保存但记账失败时不降级保存结果或重复补记', async () => {
    const f = await fixture();
    f.options.providers = {
      active: { baseUrl: 'http://synthetic.invalid/v1', model: 'fake' },
      apiKey: 'synthetic-only',
    } as ProvidersApi;
    Object.assign(f.options.db, {
      ledger: {
        record: async () => {
          throw new Error('记账失败');
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '合成完成' } }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await render(f.options).send('合成请求');
    const api = render(f.options);
    expect((await f.repository.listMessages(f.world.id)).map((m) => m.role)).toEqual(['player', 'admin']);
    expect(api.canStop).toBe(false);
    if (!api.processScope || !api.activeRunId) throw new Error('missing process');
    expect(adminProcessStore.get(api.processScope, { runId: api.activeRunId })?.phase).toBe('saved-accounting-failed');
  });
  it('切世界后拒绝旧起草且不写当前世界', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    f.options.session = { ...f.options.session, world: { ...f.world, id: roomId('admin-world-b') } };
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"wrong-world"}}');
    api = render(f.options);
    expect(f.options.session.setWorldScene).not.toHaveBeenCalled();
    expect(api.error).toMatch(/所属|来源|原世界/);
  });
  it('提示词准备后场景已修改，不能应用旧场景起草', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await f.repository.saveScene({ ...f.scene, location: 'newer' });
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"old-draft"}}');
    api = render(f.options);
    expect(f.options.session.setWorldScene).not.toHaveBeenCalled();
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('newer');
    expect(api.error).toMatch(/变化|修改|重新/);
  });
  it('等待起草时直接再次send不新增玩家消息或替换提示词', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('first');
    api = render(f.options);
    const prompt = api.bridge?.prompt;
    await api.send('second');
    api = render(f.options);
    expect(f.options.session.appendMessages).toHaveBeenCalledTimes(1);
    expect(api.bridge?.prompt).toBe(prompt);
  });
  it('合法来源的场景及管理员消息一起持久化', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"accepted"}}');
    expect((await f.repository.getScene(f.scene.id))?.location, render(f.options).error ?? '').toBe('accepted');
    expect((await f.repository.listMessages(f.world.id)).some((message) => message.role === 'admin')).toBe(true);
  });
  it('换账户拒绝旧桥接，回到原来源可以继续', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    f.options.accountKey = 'account-b';
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    f.options.accountKey = 'account-a';
    api = render(f.options);
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"resumed"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('resumed');
  });
  it('来源读取失败时不应用，允许保留旧进度', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    vi.spyOn(f.repository, 'atomic').mockRejectedValueOnce(new Error('Synthetic source read failed'));
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect(render(f.options).bridge).not.toBeNull();
    expect(render(f.options).error).toContain('Synthetic source read failed');
  });
  it('全局素材变化也拒绝此前准备的提示词', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    await f.repository.saveCard(createBlankCard({ name: 'Synthetic changed source' }));
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"blocked"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect(render(f.options).error).toMatch(/变化/);
  });
  it('管理员消息落盘失败时场景一起回滚', async () => {
    const f = await fixture();
    let api = render(f.options);
    await api.send('prepare');
    api = render(f.options);
    const atomic = f.repository.atomic.bind(f.repository);
    vi.spyOn(f.repository, 'atomic').mockImplementation((run) =>
      atomic(async (tx, store) => {
        tx.appendMessages = async () => {
          throw new Error('Synthetic admin message write failed');
        };
        return run(tx, store);
      }),
    );
    await api.commitBridge('{"tool":"set_scene","arguments":{"location":"must-rollback"}}');
    expect((await f.repository.getScene(f.scene.id))?.location).toBe('original');
    expect((await f.repository.listMessages(f.world.id)).filter((message) => message.role === 'admin')).toHaveLength(0);
    expect(render(f.options).bridge).not.toBeNull();
    expect(render(f.options).error).toContain('Synthetic admin message write failed');
  });
  it('发送接受在玩家保存后返回，不因提示词读取失败清空错误来源', async () => {
    const f = await fixture();
    const accepted = vi.fn();
    vi.spyOn(f.repository, 'atomic').mockRejectedValueOnce(new Error('Synthetic prepare read failed'));
    const result = await render(f.options).send('saved-player', accepted);
    expect(result).toEqual({ status: 'accepted' });
    expect(accepted).toHaveBeenCalledWith(result);
    expect((await f.repository.listMessages(f.world.id)).map((message) => message.content)).toEqual(['saved-player']);
    expect(render(f.options).bridge).toBeNull();
    expect(render(f.options).error).toContain('Synthetic prepare read failed');
  });
});
