import {
  buildSignatures,
  conversationId,
  type InstanceId,
  instanceId,
  type Message,
  messageId,
  roomId,
  sceneId,
} from '@dramatis/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type MessageHandlers, MessageItem } from './MessageItem';

vi.mock('../lib/render-count', () => ({ countRender: () => {} }));

const QIN = instanceId('inst-qin');
const CHEN = instanceId('inst-chen');

const SIGNATURES = buildSignatures([
  { instanceId: QIN, displayName: '秦娘', material: ['酒铺掌柜，柜台擦得能照出人影。'] },
  { instanceId: CHEN, displayName: '陈九', material: ['走货的，八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的。'] },
]);

const CHEN_LINE = '我八岁那年雷砸了船，船板掀起来，攥缆绳攥出来的。';

function messageOf(
  role: 'character' | 'player',
  speakerInstanceId: InstanceId | null,
  speakerName: string,
  content: string,
): Message {
  return {
    id: messageId('message-1'),
    roomId: roomId('room-1'),
    conversationId: conversationId('conv-1'),
    sceneId: sceneId('scene-1'),
    turnId: 'turn-1',
    localSeq: 1,
    deviceId: 'device-1',
    role,
    speakerInstanceId,
    speakerName,
    audience: [],
    content,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    deletedAt: null,
  };
}

const handlers: MessageHandlers = {
  onContextMenu: () => {},
  onPressStart: () => {},
  onPressCancel: () => {},
  onClickCapture: () => {},
  onStartEdit: () => {},
  onCancelEdit: () => {},
  onEdit: () => {},
  onRegenerate: () => {},
  onDelete: () => {},
  onReassign: () => {},
};

function render(message: Message, options: { isLastCharacter?: boolean; withSignatures?: boolean } = {}): string {
  return renderToString(
    createElement(MessageItem, {
      message,
      cast: [
        { id: QIN, displayName: '秦娘' },
        { id: CHEN, displayName: '陈九' },
      ],
      avatars: {},
      isLastCharacter: options.isLastCharacter ?? false,
      editing: false,
      highlighted: false,
      menuOpen: false,
      showIntent: false,
      archived: false,
      manualMode: false,
      signatures: options.withSignatures === false ? [] : SIGNATURES,
      handlers,
    }),
  );
}

describe('跨角色串线提示（顺序 79）', () => {
  it('秦娘说了陈九的身世 → 画出警告、原话证据与一键改归属', () => {
    const html = render(messageOf('character', QIN, '秦娘', CHEN_LINE), { isLastCharacter: true });
    // 注：renderToString 会在插值之间插入 `<!-- -->`，所以断言只钉不跨插值的片段
    expect(html).toContain('⚠ 这条可能不是');
    expect(html).toContain('独有的说法');
    expect(html).toContain('title="「八岁那年雷砸了船」写在他的角色卡里"');
    expect(html).toContain('改成「');
    expect(html).toContain('重抽这条');
  });

  it('不是最后一条时只给改归属，不给重抽', () => {
    const html = render(messageOf('character', QIN, '秦娘', CHEN_LINE));
    expect(html).toContain('改成「');
    expect(html).not.toContain('重抽这条');
  });

  it('陈九说自己的身世 → 不画警告', () => {
    const html = render(messageOf('character', CHEN, '陈九', CHEN_LINE));
    expect(html).not.toContain('⚠');
  });

  it('玩家消息不评估', () => {
    const html = render(messageOf('player', null, '我', CHEN_LINE));
    expect(html).not.toContain('⚠');
  });

  it('没有角色卡素材时安静（空签名）', () => {
    const html = render(messageOf('character', QIN, '秦娘', CHEN_LINE), { withSignatures: false });
    expect(html).not.toContain('⚠');
  });
});
