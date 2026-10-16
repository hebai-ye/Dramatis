import { type AdminArtifact, createBlankCard, createPlayerMessage, createTurnId, roomId } from '@dramatis/core';
import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AdminArtifactCard } from './AdminArtifactCard';

const host = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const i = host.cursor++;
    if (!(i in host.cells)) host.cells[i] = typeof initial === 'function' ? initial() : initial;
    return [
      host.cells[i],
      (next: unknown) => {
        host.cells[i] = typeof next === 'function' ? next(host.cells[i]) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = host.cursor++;
    host.cells[i] ??= { current: initial };
    return host.cells[i];
  },
}));
beforeEach(() => {
  host.cells = [];
  host.cursor = 0;
});
function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== 'object') return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [
    element,
    ...(Array.isArray(element.props?.children) ? element.props.children : [element.props?.children]).flatMap(nodes),
  ];
}
function text(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as ReactElement<{ children: unknown }>).props?.children) : '';
}
it('采纳等待锁定同卡重入，冲突返回不冒充成功', async () => {
  const card = createBlankCard({ name: '秦娘' }),
    artifact: AdminArtifact = {
      id: 'draft',
      kind: 'character-card',
      title: '秦娘',
      summary: '新建',
      status: 'pending',
      payload: card,
      targetId: null,
      createdAt: card.createdAt,
    };
  const message = {
    ...createPlayerMessage({
      roomId: roomId('r'),
      conversationId: null,
      sceneId: null,
      turnId: createTurnId(),
      speakerName: '测试',
      content: '草稿',
      audience: [],
    }),
    artifacts: [artifact],
  };
  let resolve!: (value: unknown) => void,
    calls = 0;
  const pending = new Promise<unknown>((done) => {
    resolve = done;
  });
  const props = {
    artifact,
    disabled: false,
    exists: false,
    scopeKey: 'source',
    onAdopt: async () => {
      calls++;
      return await pending;
    },
    onDiscard: async () => ({ status: 'missing', reason: 'fixture' }),
  };
  const render = () => {
    host.cursor = 0;
    return AdminArtifactCard(props as Parameters<typeof AdminArtifactCard>[0]);
  };
  const button = nodes(render()).find((n) => n.type === 'button' && text(n.props.children) === '采纳');
  if (!button) throw new Error('missing adopt');
  const action = button.props.onClick as () => Promise<void>;
  const first = action();
  await action();
  expect(calls).toBe(1);
  expect(text(render())).toContain('采纳中');
  resolve({ status: 'blocked', message, artifact: { ...artifact, conflict: '版本冲突' }, reason: '版本冲突' });
  await first;
  const result = render();
  expect(text(result)).toContain('版本冲突');
  expect(text(result)).not.toContain('已采纳');
});
