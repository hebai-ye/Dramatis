import {
  type AdminArtifact,
  createBlankCard,
  createConversation,
  createInstanceFor,
  createSceneFor,
  createWorldBookEntry,
  type Message,
  messageId,
  roomId,
  type Scene,
  type WorldBook,
  worldBookId,
} from '@dramatis/core';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SceneDialog, type SceneSwitchResult } from '../../src/components/SceneDialog';
import { SideChat } from '../../src/components/SideChat';
import { WebBridgePanel } from '../../src/components/WebBridgePanel';
import { WorldBookDiff } from '../../src/components/WorldBookDiff';
import '../../src/styles.css';

type Pending = { resolve: () => void; reject: (error: Error) => void };
const pending: Pending[] = [];
const api = {
  calls: [] as Array<{ operation: string; value: unknown }>,
  mode: 'immediate' as 'immediate' | 'defer' | 'fail' | 'noop',
  switchResult: { status: 'complete' } as SceneSwitchResult,
  settle: (success: boolean) => {
    const item = pending.shift();
    if (!item) throw new Error('No pending fixture action');
    if (success) item.resolve();
    else item.reject(new Error('固定失败：写入被拒'));
  },
  setPrompt: (_prompt: string) => {},
  replaceScene: () => {},
};
declare global {
  interface Window {
    optimization: typeof api;
  }
}
window.optimization = api;
async function action(operation: string, value: unknown) {
  api.calls.push({ operation, value });
  if (api.mode === 'fail') throw new Error('固定失败：写入被拒');
  if (api.mode === 'defer')
    await new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
}
const room = roomId('optimization-room');
const conversation = createConversation({ roomId: room, title: 'UI 固定夹具', kind: 'side' });
const instance = createInstanceFor(createBlankCard({ name: '阿青' }), room);
const initialScene = createSceneFor(room, conversation.id, [instance.id], {
  title: '旧城酒馆',
  location: '旧城东门',
  worldTime: '黄昏',
  summary: '酒馆里有一盏灯。',
});

function SceneFixture() {
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState(initialScene);
  api.replaceScene = () =>
    setScene(
      createSceneFor(room, conversation.id, [instance.id], {
        title: '外部新场景',
        summary: '新场景设定',
      }),
    );
  return (
    <main style={{ padding: 16 }}>
      <button type="button" data-testid="open-scene" onClick={() => setOpen(true)}>
        编辑场景
      </button>
      {open ? (
        <SceneDialog
          scene={scene}
          instances={[instance]}
          disabled={false}
          onSave={async (patch: Partial<Scene>) => {
            await action('save', patch);
            setScene((old) => ({ ...old, ...patch }));
          }}
          onStartNewScene={async (input) => {
            await action('switch', input);
            if (api.switchResult.status !== 'unavailable')
              setScene(createSceneFor(room, conversation.id, input.cast, input));
            return api.switchResult;
          }}
          onClose={() => {
            api.calls.push({ operation: 'close', value: null });
            setOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

const date = '2026-10-11T00:00:00.000Z';
const before: WorldBook = {
  id: worldBookId('optimization-book'),
  name: '旧城',
  extensions: {},
  createdAt: date,
  updatedAt: date,
  deletedAt: null,
  entries: [
    { ...createWorldBookEntry({ title: '城门', content: '原城门正文', keys: ['城门'] }), id: 'entry-modify' },
    {
      ...createWorldBookEntry({ title: '旧告示', content: '删除正文\n保留可读换行', keys: ['告示'] }),
      id: 'entry-delete',
      extensions: { unknownFlag: true },
    },
  ],
};
const after: WorldBook = {
  ...before,
  name: '旧城修订',
  entries: [
    {
      ...createWorldBookEntry({ title: '城门', content: '新城门正文', keys: ['城门', '东门'], constant: true }),
      id: 'entry-modify',
    },
    {
      ...createWorldBookEntry({
        title: '酒馆',
        content: `新增正文\n第二行设定\n${'continuity_'.repeat(40)}`,
        keys: ['酒馆'],
      }),
      id: 'entry-add',
      extensions: { preserved: '完整扩展' },
    },
  ],
};
const artifacts: AdminArtifact[] = [
  {
    id: 'a',
    kind: 'character-card',
    title: '阿青的角色卡',
    summary: '新建角色',
    status: 'pending',
    payload: { description: '守城人' },
    targetId: null,
    createdAt: date,
  },
  {
    id: 'b',
    kind: 'character-card',
    title: '酒馆老板',
    summary: '新建角色',
    status: 'pending',
    payload: {},
    targetId: null,
    createdAt: date,
  },
  {
    id: 'c',
    kind: 'world-book',
    title: '世界书修订',
    summary: '修改旧城条目',
    status: 'adopted',
    previousPayload: before,
    payload: after,
    baseUpdatedAt: before.updatedAt,
    targetId: before.id,
    createdAt: date,
  },
  {
    id: 'd',
    kind: 'character-card',
    title: '过期草稿',
    summary: '不应覆盖',
    status: 'pending',
    payload: {},
    conflict: '版本已变化，请重新起草',
    targetId: null,
    createdAt: date,
  },
];
const message: Message = {
  id: messageId('optimization-message'),
  roomId: room,
  conversationId: conversation.id,
  sceneId: null,
  turnId: 'optimization-turn',
  localSeq: 1,
  deviceId: 'fixture',
  role: 'admin',
  speakerInstanceId: null,
  speakerName: '世界管理员',
  audience: [],
  content: '固定素材预览',
  createdAt: date,
  updatedAt: date,
  deletedAt: null,
  artifacts,
};
function ArtifactFixture() {
  const [items, setItems] = useState(artifacts);
  const operate = async (operation: string, artifact: AdminArtifact) => {
    await action(operation, artifact.id);
    if (api.mode === 'noop' || operation === 'reverse') return;
    setItems((old) =>
      old.map((item) =>
        item.id === artifact.id
          ? {
              ...item,
              status: operation === 'adopt' ? 'adopted' : operation === 'revoke' ? 'pending' : 'discarded',
            }
          : item,
      ),
    );
  };
  return (
    <main style={{ display: 'flex', height: '100dvh', minHeight: 0, padding: 12 }}>
      <SideChat
        conversation={conversation}
        messages={[{ ...message, artifacts: items }]}
        worldBooks={[before]}
        busy={false}
        ready
        archived={false}
        onSend={() => {}}
        onStop={() => {}}
        onAdopt={(_id, artifact) => operate('adopt', artifact)}
        onDiscard={(_id, artifact) => operate('discard', artifact)}
        onRevoke={(_id, artifact) => operate('revoke', artifact)}
        onReverse={(_id, artifact) => operate('reverse', artifact)}
      />
    </main>
  );
}
function BridgeFixture() {
  const [prompt, setPrompt] = useState('固定提示词：旧城酒馆');
  api.setPrompt = setPrompt;
  return (
    <main style={{ padding: 16, maxWidth: 760 }}>
      <WebBridgePanel
        bridge={{ stage: 'admin', prompt }}
        busy={false}
        disabled={false}
        onReply={() => {}}
        onAnalysis={() => {}}
        onAdmin={(text) => {
          api.calls.push({ operation: 'admin', value: text });
        }}
        onSkip={() => {
          api.calls.push({ operation: 'skip', value: null });
        }}
      />
    </main>
  );
}
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'tavern';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  params.get('fixture') === 'scene' ? (
    <SceneFixture />
  ) : params.get('fixture') === 'artifact' ? (
    <ArtifactFixture />
  ) : params.get('fixture') === 'bridge' ? (
    <BridgeFixture />
  ) : (
    <main style={{ padding: 16, maxWidth: 760 }}>
      <WorldBookDiff before={before} after={after} />
    </main>
  ),
);
