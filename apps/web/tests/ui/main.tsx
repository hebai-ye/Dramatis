import { createConversation, type Message, messageId, roomId, type Scene, sceneId } from '@dramatis/core';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/components/Composer';
import { type FocusRequest, MainChat } from '../../src/components/MainChat';
import { Modal } from '../../src/components/Modal';
import { SceneDialog } from '../../src/components/SceneDialog';
import { SideChat } from '../../src/components/SideChat';
import '../../src/styles.css';

const room = roomId('ui-fixture-room');
const firstConversation = createConversation({ roomId: room, title: '浏览器定位测试' });
const secondConversation = createConversation({ roomId: room, title: '另一条对话' });
const initialMessages = Array.from(
  { length: 90 },
  (_, index): Message => ({
    id: messageId(`fixture-message-${index}`),
    roomId: room,
    conversationId: firstConversation.id,
    sceneId: null,
    turnId: `fixture-turn-${index}`,
    localSeq: index + 1,
    deviceId: 'fixture',
    role: 'character',
    speakerInstanceId: null,
    speakerName: '测试角色',
    audience: [],
    content: `第 ${index + 1} 条固定历史。这里有足够长的正文来产生真实滚动高度。`.repeat(3),
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    deletedAt: null,
  }),
);
const initialOtherMessages = initialMessages.map(
  (message, index): Message => ({
    ...message,
    id: messageId(`other-message-${index}`),
    conversationId: secondConversation.id,
    turnId: `other-turn-${index}`,
    content: `第二条对话第 ${index + 1} 条固定历史。这里有独立的滚动内容。`.repeat(3),
  }),
);

type ComposerFlags = { disabled: boolean; busy: boolean; bridgeOpen: boolean; manualMode: boolean };
type UiBridge = {
  sent: string[];
  consumed: FocusRequest[];
  setComposerFlags: (patch: Partial<ComposerFlags>) => void;
  setComposerValue: (value: string) => void;
  appendMessage: () => void;
  setFocus: (id: string, seq: number, conversation?: 'first' | 'second') => void;
  setConversation: (which: 'first' | 'second') => void;
  includeTarget: (include: boolean) => void;
  modalCloseCount: number;
  sceneEvents: string[];
  scenePatches: Array<Partial<Scene>>;
};
declare global {
  interface Window {
    uiBridge: UiBridge;
  }
}

function ComposerFixture() {
  const [value, setValue] = useState('');
  const [flags, setFlags] = useState<ComposerFlags>({
    disabled: false,
    busy: false,
    bridgeOpen: false,
    manualMode: false,
  });
  window.uiBridge.setComposerFlags = (patch) => setFlags((old) => ({ ...old, ...patch }));
  window.uiBridge.setComposerValue = setValue;
  return (
    <main data-testid="composer-fixture" style={{ padding: 24, maxWidth: 600 }}>
      <Composer
        value={value}
        onChange={setValue}
        placeholder="输入内容"
        {...flags}
        onSend={() => window.uiBridge.sent.push(value)}
        onStop={() => {}}
      />
    </main>
  );
}

function MainChatFixture({ bridge = false }: { bridge?: boolean }) {
  const [conversation, setConversation] = useState(firstConversation);
  const [messages, setMessages] = useState(initialMessages);
  const [otherMessages, setOtherMessages] = useState(initialOtherMessages);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [includeTarget, setIncludeTarget] = useState(true);
  window.uiBridge.setConversation = (which) =>
    setConversation(which === 'first' ? firstConversation : secondConversation);
  window.uiBridge.includeTarget = setIncludeTarget;
  window.uiBridge.setFocus = (id, seq, which = 'first') =>
    setFocus({
      id: messageId(id),
      seq,
      conversationId: which === 'first' ? firstConversation.id : secondConversation.id,
    });
  window.uiBridge.appendMessage = () => {
    const append = (old: Message[], which: 'first' | 'second') => {
      const index = old.length;
      return [
        ...old,
        {
          ...(which === 'first' ? initialMessages[0] : initialOtherMessages[0]),
          id: messageId(`new-message-${which}-${index}`),
          conversationId: which === 'first' ? firstConversation.id : secondConversation.id,
          content: `新消息 ${which} ${index}。这条新增内容需要真实增加滚动高度。`.repeat(3),
          localSeq: index + 1,
        },
      ];
    };
    if (conversation.id === firstConversation.id) setMessages((old) => append(old, 'first'));
    else setOtherMessages((old) => append(old, 'second'));
  };
  const visibleMessages =
    conversation.id === firstConversation.id
      ? includeTarget
        ? messages
        : messages.filter((item) => item.id !== messageId('fixture-message-10'))
      : otherMessages;
  return (
    <main
      data-testid="chat-fixture"
      data-focus-seq={focus?.seq ?? ''}
      data-conversation={conversation.id === firstConversation.id ? 'first' : 'second'}
      style={{ display: 'flex', height: '100vh', minHeight: 0, padding: 12 }}
    >
      <MainChat
        conversation={conversation}
        scene={null}
        messages={visibleMessages}
        cast={[]}
        avatars={{}}
        busy={false}
        ready={true}
        archived={false}
        focus={focus}
        bridge={bridge ? { stage: 'reply', prompt: 'fixture prompt' } : null}
        onFocusConsumed={(request) => {
          window.uiBridge.consumed.push(request);
          setFocus((current) => (current?.seq === request.seq ? null : current));
        }}
        onSend={(value) => window.uiBridge.sent.push(value)}
        onStop={() => {}}
        onRegenerate={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onChangeModes={() => {}}
        unlimitedPrompt=""
        onOpenScene={() => {}}
        onDropInstance={() => {}}
        onReassign={() => {}}
      />
    </main>
  );
}

function SideChatFixture() {
  return (
    <main data-testid="chat-fixture" style={{ display: 'flex', height: '100vh', minHeight: 0, padding: 12 }}>
      <SideChat
        conversation={secondConversation}
        messages={[]}
        busy={false}
        ready={true}
        archived={false}
        bridge={{ prompt: 'fixture prompt' }}
        onSend={(value) => window.uiBridge.sent.push(value)}
        onStop={() => {}}
        onAdopt={() => {}}
        onDiscard={() => {}}
      />
    </main>
  );
}

function ModalFixture() {
  const [open, setOpen] = useState(false);
  return (
    <main data-testid="modal-fixture">
      <button type="button" data-testid="modal-trigger" onClick={() => setOpen(true)}>
        打开测试弹窗
      </button>
      <button type="button" data-testid="background-action">
        背景按钮
      </button>
      {open ? (
        <Modal
          label="测试弹窗"
          closeLabel="收起"
          head={
            <>
              <strong>独立标题</strong>
              <input aria-label="标题内名字" defaultValue="角色名" />
            </>
          }
          footer={<button type="button">页脚末按钮</button>}
          onClose={() => {
            window.uiBridge.modalCloseCount += 1;
            setOpen(false);
          }}
        >
          <button type="button">正文按钮</button>
        </Modal>
      ) : null}
    </main>
  );
}

const fixtureScene: Scene = {
  id: sceneId('ui-fixture-scene'),
  roomId: room,
  conversationId: firstConversation.id,
  title: '原场景',
  location: '旧城',
  worldTime: '傍晚',
  castPolicy: 'open',
  cast: [],
  summary: '原始设定',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  endedAt: null,
  deletedAt: null,
};

function SceneDialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <main data-testid="scene-fixture">
      <button type="button" data-testid="scene-trigger" onClick={() => setOpen(true)}>
        打开场景弹窗
      </button>
      {open ? (
        <SceneDialog
          scene={fixtureScene}
          instances={[]}
          disabled={false}
          onSave={async (patch) => {
            window.uiBridge.scenePatches.push(patch);
            window.uiBridge.sceneEvents.push('save');
          }}
          onStartNewScene={async () => {
            window.uiBridge.sceneEvents.push('start');
            return { status: 'complete' };
          }}
          onClose={() => {
            window.uiBridge.sceneEvents.push('close');
            setOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

window.uiBridge = {
  sent: [],
  consumed: [],
  setComposerFlags: () => {},
  setComposerValue: () => {},
  appendMessage: () => {},
  setFocus: () => {},
  setConversation: () => {},
  includeTarget: () => {},
  modalCloseCount: 0,
  sceneEvents: [],
  scenePatches: [],
};
const fixture = new URLSearchParams(location.search).get('fixture');
const root = document.getElementById('root');
if (!root) throw new Error('Missing UI fixture root');
createRoot(root).render(
  fixture === 'composer' ? (
    <ComposerFixture />
  ) : fixture === 'modal' ? (
    <ModalFixture />
  ) : fixture === 'scene-dialog' ? (
    <SceneDialogFixture />
  ) : fixture === 'bridge-side' ? (
    <SideChatFixture />
  ) : (
    <MainChatFixture bridge={fixture === 'bridge-main'} />
  ),
);
