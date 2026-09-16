import {
  type AssembledPrompt,
  type Card,
  type CharacterInstance,
  createCharacterMessage,
  createGreetingMessage,
  createOpenAICompatibleProvider,
  createPersona,
  createPlayerMessage,
  createTurnId,
  type ImportWarning,
  importCardFromJson,
  importCardFromPng,
  type Message,
  type MessageId,
  type PromptMemory,
  type RecalledMemory,
  recallMemories,
  runTurn,
  type Scene,
  scheduleSpeakers,
  selectWithinBudget,
  turnsSinceLastSpoke,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardPanel } from './components/CardPanel';
import { CastPanel } from './components/CastPanel';
import { ChatPanel } from './components/ChatPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { PromptInspector } from './components/PromptInspector';
import { ProviderPanel } from './components/ProviderPanel';
import { RoomPanel } from './components/RoomPanel';
import { ScenePanel } from './components/ScenePanel';
import { MEMORY_BUDGET_TOKENS, MEMORY_TASK_KIND, useMemoryWorker } from './lib/memory';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function toPromptMemory(recalled: RecalledMemory): PromptMemory {
  const event = recalled.event;
  return {
    id: event.id,
    summary: event.summary,
    score: recalled.score,
    ...(event.perception !== '' ? { perception: event.perception } : {}),
    ...(event.timeline.worldTime !== '' ? { worldTime: event.timeline.worldTime } : {}),
  };
}

export function App() {
  const { db, boot, error: dbError } = useDatabase();
  const session = useSession(db);
  const providers = useProviders(db);

  // 记忆抽取跑在后台队列里，写完通知 session 重新载入房间
  const worker = useMemoryWorker({
    db,
    provider: providers.background,
    onIngested: () => {
      void session.reloadRoom();
    },
  });

  const [importedCard, setImportedCard] = useState<Card | null>(null);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const snapshot = session.snapshot;
  const scene = session.activeScene;
  const messages = useMemo(() => snapshot?.messages ?? [], [snapshot]);
  const personas = snapshot?.personas ?? [];
  const activePersona = personas.find((persona) => persona.id === snapshot?.room.personaId) ?? null;
  const activeCard = snapshot?.cards.find((item) => item.id === snapshot.room.cardIds[0]) ?? importedCard;
  const ready = snapshot !== null && scene !== null;

  // 没有身份就先造一个，否则新世界无从创建
  useEffect(() => {
    if (!db || !session.ready) return;
    void (async () => {
      const list = await session.listPersonas();
      if (list.length > 0) return;
      await session.savePersona(createPersona({ name: '玩家' }));
    })();
  }, [db, session]);

  /** 跑一次生成，返回角色说出的完整内容。 */
  const runGeneration = useCallback(
    async (options: {
      speaker: CharacterInstance;
      card: Card;
      history: Message[];
      playerInput: string;
      memories?: readonly PromptMemory[];
      showStream: boolean;
      signal: AbortSignal;
    }): Promise<string> => {
      const profile = providers.active;
      if (!profile || !snapshot || !scene) return '';

      const provider = createOpenAICompatibleProvider({
        baseUrl: profile.baseUrl,
        apiKey: providers.apiKey,
        model: profile.model,
      });

      let accumulated = '';
      for await (const event of runTurn(
        {
          card: options.card,
          instance: options.speaker,
          room: snapshot.room,
          scene,
          cast: snapshot.instances,
          history: options.history,
          playerInput: options.playerInput,
          memories: options.memories === undefined ? [] : [...options.memories],
          budget: { maxTokens: profile.maxTokens, reserveForReply: profile.reserveForReply },
        },
        provider,
        { params: { temperature: profile.temperature }, signal: options.signal },
      )) {
        switch (event.type) {
          case 'prompt':
            setLastPrompt(event.prompt);
            break;
          case 'reasoning':
            setReasoningText((previous) => previous + event.text);
            break;
          case 'text':
            accumulated += event.text;
            if (options.showStream) setStreamText(accumulated);
            break;
          case 'done':
            accumulated = event.text;
            break;
        }
      }
      return accumulated;
    },
    [providers, scene, snapshot],
  );

  const makeCharacterLine = useCallback(
    (speaker: CharacterInstance, content: string, turnId: string, sceneValue: Scene): Message =>
      createCharacterMessage({
        roomId: sceneValue.roomId,
        sceneId: sceneValue.id,
        turnId,
        speakerInstanceId: speaker.id,
        speakerName: speaker.displayName,
        content,
        audience: sceneValue.cast,
      }),
    [],
  );

  /** 用一张卡开一条新世界线，并写入角色的开场白。 */
  const startNewRoom = useCallback(
    async (target: Card) => {
      const persona = activePersona ?? createPersona({ name: '玩家' });
      if (!activePersona) await session.savePersona(persona);

      const created = await session.createRoom(target, persona);
      const createdInstance = created?.instances[0];
      if (!created || !createdInstance) return;

      const createdScene = created.scenes.find((item) => item.id === created.room.activeSceneId) ?? null;
      const greeting = createGreetingMessage({
        card: target,
        instance: createdInstance,
        room: created.room,
        scene: createdScene,
        audience: createdScene?.cast ?? [createdInstance.id],
      });
      if (greeting) await session.appendMessages([greeting]);
      setLastPrompt(null);
    },
    [activePersona, session],
  );

  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = looksLikePng(bytes)
          ? await importCardFromPng(bytes, file.name)
          : importCardFromJson(new TextDecoder('utf-8').decode(bytes), file.name);

        setImportedCard(result.card);
        setWarnings(result.warnings);

        // 已经有房间就把他拉进当前场景，否则开一条新世界线
        if (snapshot && scene) {
          const instance = await session.addInstance(result.card);
          if (instance) {
            const greeting = createGreetingMessage({
              card: result.card,
              instance,
              room: snapshot.room,
              scene,
              audience: [...scene.cast, instance.id],
            });
            if (greeting) await session.appendMessages([greeting]);
          }
        } else {
          await startNewRoom(result.card);
        }
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    },
    [scene, session, snapshot, startNewRoom],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!db || !snapshot || !scene || busy) return;

      const profile = providers.active;
      if (!profile) {
        setError('还没有模型配置');
        return;
      }
      if (providers.apiKey.trim() === '') {
        setError('还没有填 API Key');
        return;
      }

      setError(null);
      setBusy(true);
      setStreamText('');
      setReasoningText('');

      const turnId = createTurnId();
      const history = messages;
      const audience = scene.cast;

      const playerMessage = createPlayerMessage({
        roomId: snapshot.room.id,
        sceneId: scene.id,
        turnId,
        speakerName: snapshot.room.playerName,
        content: text,
        audience,
      });
      await session.appendMessages([playerMessage]);

      const controller = new AbortController();
      abortRef.current = controller;

      // 第一位发言者用不含本条玩家消息的历史 + playerInput；
      // 后续发言者改用含玩家消息与前一角色回应的时间线，且不再重复插入玩家输入
      let continuedHistory: Message[] = [...history, playerMessage];

      try {
        const since = turnsSinceLastSpoke(history, turnId);
        const schedule = scheduleSpeakers({
          playerInput: text,
          candidates: snapshot.instances.map((instance) => ({
            instance,
            turnsSinceSpoke: since.get(instance.id) ?? null,
          })),
          maxSpeakers: 1,
        });

        let first = true;
        for (const speakerId of schedule.speakers) {
          const speaker = snapshot.instances.find((item) => item.id === speakerId);
          if (!speaker) continue;
          const speakerCard = snapshot.cards.find((item) => item.id === speaker.cardId) ?? activeCard;
          if (!speakerCard) continue;

          // 只召回这个人自己的视角条目——这是「多角色」与「一个角色的多个分身」
          // 之间的分界线，也是 P1-3 的接入点
          const now = new Date().toISOString();
          const recalled = selectWithinBudget(
            recallMemories(snapshot.memories, {
              observerId: speaker.id,
              text: [text, ...history.slice(-6).map((message) => message.content)].join('\n'),
              participantIds: scene.cast,
              location: scene.location,
              now,
            }),
            MEMORY_BUDGET_TOKENS,
          );

          const reply = await runGeneration({
            speaker,
            card: speakerCard,
            history: first ? history : continuedHistory,
            playerInput: first ? text : '',
            memories: recalled.map(toPromptMemory),
            showStream: true,
            signal: controller.signal,
          });
          first = false;

          if (recalled.length > 0) {
            void session.markRecalled(
              recalled.map((item) => item.event),
              now,
            );
          }

          if (reply.trim() !== '') {
            const line = makeCharacterLine(speaker, reply, turnId, scene);
            await session.appendMessages([line]);
            continuedHistory = [...continuedHistory, line];
          }
        }

        // 抽成一块后台任务，不阻塞对话；负载只存 id，内容现取
        await db.queue.enqueue({
          kind: MEMORY_TASK_KIND,
          idempotencyKey: `${MEMORY_TASK_KIND}:${turnId}`,
          roomId: snapshot.room.id,
          turnId,
          payload: { roomId: snapshot.room.id, sceneId: scene.id, turnId },
        });
        worker.kick();
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        setStreamText('');
        setReasoningText('');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [activeCard, busy, db, makeCharacterLine, messages, providers, runGeneration, scene, session, snapshot, worker],
  );

  /**
   * 重抽（P0-7）。
   *
   * 关键不是「再生成一次」，而是**把这一轮的记忆写入撤销掉**：
   * 先取消这个回合排队中的后台任务，再删掉旧的回复，否则角色会同时
   * 记得两个互相矛盾的版本。
   */
  const handleRegenerate = useCallback(
    async (id: MessageId) => {
      if (!db || !snapshot || !scene || busy) return;

      const target = messages.find((message) => message.id === id);
      if (!target) return;

      const turnMessages = messages.filter((message) => message.turnId === target.turnId);
      const playerMessage = turnMessages.find((message) => message.role === 'player');
      if (!playerMessage) {
        setError('这一轮找不到对应的玩家发言，无法重抽');
        return;
      }

      const speaker = snapshot.instances.find((item) => item.id === target.speakerInstanceId);
      const speakerCard = speaker ? snapshot.cards.find((item) => item.id === speaker.cardId) : null;
      if (!speaker || !speakerCard) {
        setError('找不到这条回复对应的角色');
        return;
      }

      setError(null);
      setBusy(true);
      setStreamText('');
      setReasoningText('');

      await db.queue.cancelByTurn(target.turnId);
      await session.deleteMemoriesByTurn(target.turnId);
      for (const message of turnMessages) {
        if (message.role === 'character') await session.deleteMessage(message.id);
      }

      const earlierHistory = messages.filter((message) => message.turnId !== target.turnId);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const reply = await runGeneration({
          speaker,
          card: speakerCard,
          history: earlierHistory,
          playerInput: playerMessage.content,
          showStream: true,
          signal: controller.signal,
        });

        if (reply.trim() !== '') {
          await session.appendMessages([makeCharacterLine(speaker, reply, target.turnId, scene)]);
        }
      } catch (regenerateError) {
        const message = regenerateError instanceof Error ? regenerateError.message : String(regenerateError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        setStreamText('');
        setReasoningText('');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, db, makeCharacterLine, messages, runGeneration, scene, session, snapshot],
  );

  const handleDeleteMessage = useCallback(
    async (id: MessageId) => {
      const target = messages.find((message) => message.id === id);
      if (!target) return;

      // 删掉角色的回复，就等于这一轮没有发生过，排队的记忆抽取也要一起撤销
      if (target.role === 'character' && db) {
        await db.queue.cancelByTurn(target.turnId);
        await session.deleteMemoriesByTurn(target.turnId);
      }
      await session.deleteMessage(id);
    },
    [db, messages, session],
  );

  const handleStop = useCallback(() => abortRef.current?.abort(), []);
  const displayError = error ?? session.error ?? dbError;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>Dramatis</h1>
          <span>登场 · P0{boot ? ` · 存储：${boot.backendKind}` : ''}</span>
        </header>

        <RoomPanel
          rooms={session.rooms}
          activeRoomId={snapshot?.room.id ?? null}
          backendKind={boot?.backendKind ?? ''}
          degraded={boot?.degraded ?? false}
          personas={personas}
          activePersonaId={activePersona?.id ?? null}
          onUsePersona={(id) => {
            const persona = personas.find((item) => item.id === id);
            if (persona) void session.setPersona(persona);
          }}
          onCreatePersona={() => {
            const persona = createPersona({ name: '新身份' });
            void session.savePersona(persona).then(() => session.setPersona(persona));
          }}
          onUpdatePersona={(patch) => {
            if (activePersona) void session.savePersona({ ...activePersona, ...patch });
          }}
          onOpenRoom={(id) => {
            void session.openRoom(id);
            setLastPrompt(null);
          }}
          onDeleteRoom={(id) => void session.deleteRoom(id)}
          onNewWorld={() => {
            if (activeCard) void startNewRoom(activeCard);
          }}
          canStartNewWorld={activeCard !== null}
          disabled={busy || !session.ready}
        />

        <CardPanel
          card={activeCard}
          warnings={warnings}
          error={displayError}
          disabled={busy || !session.ready}
          importHint={snapshot ? '导入的角色会加入当前房间' : '导入的角色会开一条新世界线'}
          onImport={(file) => {
            void handleImport(file);
          }}
        />

        {scene && snapshot ? (
          <CastPanel
            instances={snapshot.instances}
            scene={scene}
            disabled={busy}
            onSetPresence={(id, presence) => void session.setPresence(id, presence)}
            onRename={(id, name) => void session.updateInstance(id, { displayName: name })}
            onRemove={(id) => void session.removeInstance(id)}
          />
        ) : null}

        {scene ? (
          <ScenePanel
            scene={scene}
            disabled={busy}
            onChange={(patch) => void session.updateScene(patch)}
            onStartNewScene={(title) => void session.startNewScene(title)}
          />
        ) : null}

        {snapshot ? (
          <MemoryPanel
            memories={snapshot.memories}
            instances={snapshot.instances}
            pending={worker.pending}
            workerError={worker.lastError}
            disabled={busy}
            onUpdate={(id, patch) => void session.updateMemory(id, patch)}
            onDelete={(id) => void session.deleteMemory(id)}
          />
        ) : null}

        <ProviderPanel api={providers} disabled={busy} />
      </aside>

      <main className="main">
        <ChatPanel
          messages={messages}
          streamText={streamText}
          reasoningText={reasoningText}
          busy={busy}
          ready={ready}
          characterName={snapshot?.instances[0]?.displayName ?? ''}
          onSend={(text) => {
            void handleSend(text);
          }}
          onStop={handleStop}
          onReset={() => {
            if (activeCard) void startNewRoom(activeCard);
          }}
          onRegenerate={(id) => void handleRegenerate(id)}
          onEdit={(id, content) => void session.updateMessage(id, { content })}
          onDelete={(id) => void handleDeleteMessage(id)}
        />
        <PromptInspector prompt={lastPrompt} />
      </main>
    </div>
  );
}
