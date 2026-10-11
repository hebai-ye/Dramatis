import {
  type AdminArtifact,
  createBlankWorldBook,
  createConversation,
  createPlayerMessage,
  createWorldBookEntry,
  roomId,
} from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SideChat } from './SideChat';

vi.mock('../lib/render-count', () => ({ countRender: () => {} }));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Fixture value missing');
  return value;
}

const room = roomId('room');
const side = createConversation({ roomId: room, kind: 'side', title: '管理' });
const before = {
  ...createBlankWorldBook('旧书名'),
  entries: [createWorldBookEntry({ title: '旧条目', content: '旧正文', constant: true })],
};
const after = { ...before, name: '新书名', entries: [{ ...required(before.entries[0]), content: '新正文' }] };
const artifact: AdminArtifact = {
  id: 'draft',
  kind: 'world-book',
  title: after.name,
  summary: '修改世界书',
  status: 'pending',
  payload: after,
  previousPayload: before,
  baseUpdatedAt: before.updatedAt,
  targetId: null,
  createdAt: before.createdAt,
};
function render(
  draft = artifact,
  mains = [
    createConversation({ roomId: room, kind: 'main', title: '主线一' }),
    createConversation({ roomId: room, kind: 'main', title: '主线二' }),
  ],
) {
  return renderToString(
    createElement(SideChat, {
      conversation: side,
      conversations: mains,
      worldBooks: [before],
      messages: [
        {
          ...createPlayerMessage({
            roomId: room,
            conversationId: side.id,
            sceneId: null,
            turnId: 't',
            speakerName: '管理',
            content: '',
            audience: [],
          }),
          artifacts: [draft],
        },
      ],
      busy: false,
      ready: true,
      archived: false,
      onSend: () => {},
      onStop: () => {},
      onAdopt: () => {},
      onDiscard: () => {},
      onRevoke: () => {},
      onReverse: () => {},
    }),
  );
}
describe('admin review controls', () => {
  it('shows expandable exact field changes before adoption', () => {
    const html = render();
    expect(html).toContain('<details');
    for (const value of ['旧书名', '新书名', '旧正文', '新正文']) expect(html).toContain(value);
  });
  it('uses reverse draft instead of revoke for modifications', () => {
    const html = render({ ...artifact, status: 'adopted' });
    expect(html).toContain('起草反向修改');
    expect(html).not.toContain('撤回这次采纳');
  });
  it('blocks a legacy modification without before', () => {
    const { previousPayload: _before, ...legacy } = artifact;
    const html = render(legacy);
    expect(html).toContain('重新起草');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>采纳/);
  });
  it('requires a selection for multiple mains and explains zero mains', () => {
    expect(render()).toContain('请选择场景目标');
    expect(render(artifact, [])).toContain('没有主对话');
  });
});
