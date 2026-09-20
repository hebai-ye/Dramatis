import { describe, expect, it } from 'vitest';
import { createBlankCard } from '../model/card.js';
import { createConversation } from '../model/conversation.js';
import { conversationId, instanceId, messageId, newId, roomId, sceneId } from '../model/ids.js';
import type { CharacterInstance } from '../model/instance.js';
import type { Message } from '../model/message.js';
import type { Scene } from '../model/room.js';
import { createInstanceFor } from '../session/setup.js';
import { buildConversationTranscript, suggestTranscriptName } from './transcript.js';

const ROOM = roomId('room-1');

function instance(name: string): CharacterInstance {
  return {
    ...createInstanceFor(createBlankCard({ name, nickname: name }), ROOM),
    id: instanceId(name),
    displayName: name,
  };
}

function scene(id: string, title: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id: sceneId(id),
    roomId: ROOM,
    conversationId: conversationId('conv-1'),
    title,
    location: '',
    worldTime: '',
    castPolicy: 'open',
    cast: [],
    summary: '',
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    endedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function message(overrides: Partial<Message> & { role: Message['role'] }): Message {
  return {
    id: messageId(newId()),
    roomId: ROOM,
    conversationId: conversationId('conv-1'),
    sceneId: sceneId('scene-1'),
    turnId: 'turn-1',
    localSeq: 1,
    deviceId: 'device-1',
    speakerInstanceId: null,
    speakerName: '',
    audience: [],
    content: '内容',
    createdAt: '2026-09-18T10:01:00.000Z',
    updatedAt: '2026-09-18T10:01:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const conversation = {
  ...createConversation({ roomId: ROOM, title: '河滩旧道' }),
  id: conversationId('conv-1'),
  archivedAt: '2026-09-20T13:00:00.000Z',
};

describe('buildConversationTranscript', () => {
  const cast = [instance('小满'), instance('陈九')];

  it('抬头写清是哪条线、何时归档，正文按场景分段', () => {
    const text = buildConversationTranscript({
      conversation,
      worldTitle: '回归世界',
      scenes: [scene('scene-1', '河滩', { location: '河滩', worldTime: '第九日' })],
      messages: [
        message({ role: 'player', speakerName: '沈砚', content: '这条旧道还走船吗？' }),
        message({
          role: 'character',
          speakerInstanceId: instanceId('小满'),
          speakerName: '小满',
          content: '「走，只是过不了大船。」',
          localSeq: 2,
          createdAt: '2026-09-18T10:02:00.000Z',
        }),
      ],
      instances: cast,
      exportedAt: '2026-09-20T13:05:00.000Z',
    });

    expect(text).toContain('# 回归世界 · 河滩旧道');
    expect(text).toContain('- 归档于：2026-09-20T13:00:00.000Z');
    expect(text).toContain('## 河滩（河滩 · 第九日）');
    expect(text).toContain('**沈砚**：这条旧道还走船吗？');
    expect(text).toContain('**小满**：「走，只是过不了大船。」');
  });

  it('按时间排序，顺手把消息里的换行压成一行', () => {
    const text = buildConversationTranscript({
      conversation,
      scenes: [scene('scene-1', '开场')],
      messages: [
        message({
          role: 'character',
          speakerName: '陈九',
          content: '后半句',
          localSeq: 2,
          createdAt: '2026-09-18T10:05:00.000Z',
        }),
        message({
          role: 'player',
          speakerName: '沈砚',
          content: '前半句',
          localSeq: 1,
          createdAt: '2026-09-18T10:01:00.000Z',
        }),
        message({
          role: 'character',
          speakerName: '陈九',
          content: '换\n行',
          localSeq: 3,
          createdAt: '2026-09-18T10:06:00.000Z',
        }),
      ],
      instances: cast,
    });

    expect(text.indexOf('前半句')).toBeLessThan(text.indexOf('后半句'));
    expect(text).toContain('**陈九**：换 行');
  });

  it('场景之外的消息单独成段，不会被丢掉', () => {
    const text = buildConversationTranscript({
      conversation,
      scenes: [scene('scene-1', '开场')],
      messages: [message({ role: 'narration', speakerName: '', sceneId: null, content: '小满 进入了 河滩旧道' })],
      instances: cast,
    });

    expect(text).toContain('## 未分场的消息');
    expect(text).toContain('**旁白**：小满 进入了 河滩旧道');
  });

  it('消息指向不存在的场景时也不丢，单独标出来', () => {
    const text = buildConversationTranscript({
      conversation,
      scenes: [],
      messages: [message({ role: 'player', speakerName: '沈砚', sceneId: sceneId('gone'), content: '还在吗' })],
      instances: cast,
    });

    expect(text).toContain('## 场景已不存在');
    expect(text).toContain('**沈砚**：还在吗');
  });

  it('空对话也给一份合法的正文，而不是空字符串', () => {
    const text = buildConversationTranscript({ conversation, scenes: [], messages: [], instances: [] });
    expect(text).toContain('# 河滩旧道');
    expect(text).toContain('- 消息条数：0');
  });

  it('世界管理员的消息写成「世界管理员」', () => {
    const text = buildConversationTranscript({
      conversation,
      scenes: [],
      messages: [message({ role: 'admin', speakerName: '', content: '这条世界书我起草好了', sceneId: null })],
      instances: [],
    });
    expect(text).toContain('**世界管理员**：这条世界书我起草好了');
  });
});

describe('suggestTranscriptName', () => {
  it('归档过的写成「归档」，没归档的写成「对话」，并带上时间戳', () => {
    expect(suggestTranscriptName(conversation, new Date(2026, 8, 20, 21, 30))).toBe(
      'dramatis-归档-河滩旧道-20260920-2130.md',
    );
    expect(suggestTranscriptName({ ...conversation, archivedAt: null }, new Date(2026, 8, 20, 21, 30))).toBe(
      'dramatis-对话-河滩旧道-20260920-2130.md',
    );
  });

  it('标题里有非法字符时不会带进文件名', () => {
    const name = suggestTranscriptName({ ...conversation, title: 'a/b:c*d?' }, new Date(2026, 0, 2, 3, 4));
    expect(name).toBe('dramatis-归档-a-b-c-d--20260102-0304.md');
  });
});
