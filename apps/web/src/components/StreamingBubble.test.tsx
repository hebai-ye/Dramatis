import type { MessageId } from '@dramatis/core';
import { createElement, createRef } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoffStreamState, resetStreamState, setStreamState } from '../lib/stream-store';
import { StreamingBubble } from './StreamingBubble';

vi.mock('../lib/render-count', () => ({ countRender: () => {} }));

const messageId = 'message-a' as MessageId;

function render(lastMessageId: MessageId | null): string {
  return renderToString(
    createElement(StreamingBubble, {
      busy: true,
      onStop: () => {},
      lastMessageId,
      suspendAutoScroll: false,
      bottomRef: createRef<HTMLDivElement>(),
      cast: [],
      avatars: {},
    }),
  );
}

afterEach(() => resetStreamState('main'));

describe('流式气泡交接渲染', () => {
  it('已落盘但列表尚未出现时仍画旧流，出现同一 ID 的提交后不重影', () => {
    setStreamState('main', { text: '甲先回答了', speaker: '甲', phase: 'writing' });
    handoffStreamState('main', messageId);
    expect(render(null)).toContain('甲先回答了');
    expect(render(messageId)).not.toContain('甲先回答了');
  });
});
