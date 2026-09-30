import { conversationId, createConversation, type Message, messageId, roomId } from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffStreamState, resetStreamState, setStreamState } from '../lib/stream-store';
import { SideChat } from './SideChat';

vi.mock('../lib/render-count', () => ({ countRender: () => {} }));

const ROOM = roomId('room-1');

const CONVERSATION = createConversation({ roomId: ROOM, title: '世界管理' });

function adminMessage(content: string, id = 'message-1'): Message {
  return {
    id: messageId(id),
    roomId: ROOM,
    conversationId: conversationId('conv-1'),
    sceneId: null,
    turnId: 'turn-1',
    localSeq: 1,
    deviceId: 'device-1',
    role: 'admin',
    speakerInstanceId: null,
    speakerName: '世界管理员',
    audience: [],
    content,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    deletedAt: null,
  };
}

function render(messages: Message[], busy = false): string {
  return renderToString(
    createElement(SideChat, {
      conversation: CONVERSATION,
      messages,
      busy,
      ready: true,
      archived: false,
      onSend: () => {},
      onStop: () => {},
      onAdopt: () => {},
      onDiscard: () => {},
    }),
  );
}

describe('副对话的流式与工具调用可见（顺序 104）', () => {
  beforeEach(() => {
    resetStreamState('admin');
  });

  it('正文逐字流出来时就画在管理员那一行里', () => {
    setStreamState('admin', { text: '我来起草一个酒馆老板。', phase: 'writing' });
    const html = render([]);
    expect(html).toContain('我来起草一个酒馆老板。');
    expect(html).toContain('admin-text streaming');
  });

  it('工具调用显示草稿自己的中文摘要', () => {
    setStreamState('admin', { progress: '新建角色卡「秦娘」' });
    const html = render([]);
    expect(html).toContain('工具调用：');
    expect(html).toContain('新建角色卡「秦娘」');
  });

  it('还在等模型开口时先给一句话，不是空白', () => {
    const html = render([], true);
    expect(html).toContain('正在准备…');
  });

  it('不忙也没有流式内容时不画这一行', () => {
    const html = render([adminMessage('草稿放在下面了。')]);
    expect(html).not.toContain('正在准备…');
    expect(html).not.toContain('streaming');
  });

  it('这一轮已经落盘（交接给消息列表）之后不再重复画流式副本', () => {
    const message = adminMessage('草稿放在下面了。', 'message-9');
    setStreamState('admin', { text: '草稿放在下面了。', phase: 'writing' });
    // 交接的语义：落盘那一刻只记 id，正文留着，等消息进列表后由这里收掉
    handoffStreamState('admin', message.id);
    const html = render([message]);
    expect(html).not.toContain('streaming');
    expect(html.match(/草稿放在下面了。/gu)?.length).toBe(1);
  });
});
