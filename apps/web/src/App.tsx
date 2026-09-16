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
  matchWorldBookEntries,
  type PromptMemory,
  parseWorldBook,
  type RecalledMemory,
  recallMemories,
  runTurn,
  type Scene,
  scheduleSpeakers,
  selectWithinBudget,
  turnsSinceLastSpoke,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { DesignSidebar } from './components/DesignSidebar';
import { RuntimePanel } from './components/RuntimePanel';
import { TopBar } from './components/TopBar';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';
import { AFFECT_TASK_KIND, MEMORY_BUDGET_TOKENS, MEMORY_TASK_KIND, useBackgroundWorker } from './lib/worker';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/** 世界书与角色卡都是 JSON，用有没有 `entries` 来区分。 */
function looksLikeWorldBook(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'entries' in value;
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

  const worker = useBackgroundWorker({
    db,
    provider: providers.background,
    onChanged: () => {
      void session.reloadRoom();
    },
  });

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
  const activeCard = snapshot?.cards.find((item) => item.id === snapshot.room.cardIds[0]) ?? null;
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

      // 世界书按关键词命中插入，扫描范围是玩家输入加最近几轮
      const scanText = [options.playerInput, ...options.history.slice(-8).map((message) => message.content)].join('\n');
      const worldBookMatches = snapshot.worldBooks.flatMap((book) => matchWorldBookEntries(book, { scanText }));

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
          worldBookMatches,
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
      const persona = activePersona ?? personas[0];
      if (!persona) {
        setError('先创建一个玩家身份');
        return;
      }

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
    [activePersona, personas, session],
  );

  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (!looksLikePng(bytes)) {
          const text = new TextDecoder('utf-8').decode(bytes);
          const parsed = JSON.parse(text) as unknown;

          if (looksLikeWorldBook(parsed)) {
            const { book, warnings: bookWarnings } = parseWorldBook(parsed, file.name.replace(/\.json$/i, ''));
            await session.saveWorldBook(book);
            setWarnings(bookWarnings);
            return;
          }
        }

        const result = looksLikePng(bytes)
          ? await importCardFromPng(bytes, file.name)
          : importCardFromJson(new TextDecoder('utf-8').decode(bytes), file.name);

        // 先入库，再决定要不要马上用
        await session.saveCard(result.card);
        setWarnings(result.warnings);

        if (!snapshot || !scene) {
          await startNewRoom(result.card);
        }

        if (result.card.embeddedWorldBook !== null) {
          const { book } = parseWorldBook(result.card.embeddedWorldBook, `${result.card.name} 的内嵌世界书`);
          await session.saveWorldBook(book);
          if (snapshot) await session.attachWorldBook(book);
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
          const speakerCard = snapshot.cards.find((item) => item.id === speaker.cardId);
          if (!speakerCard) continue;

          // 只召回这个人自己的视角条目
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

        // 抽成两块后台任务，不阻塞对话；负载只存 id，内容现取
        const payload = { roomId: snapshot.room.id, sceneId: scene.id, turnId };
        for (const kind of [MEMORY_TASK_KIND, AFFECT_TASK_KIND]) {
          await db.queue.enqueue({
            kind,
            idempotencyKey: `${kind}:${turnId}`,
            roomId: snapshot.room.id,
            turnId,
            payload,
          });
        }
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
    [busy, db, makeCharacterLine, messages, providers, runGeneration, scene, session, snapshot, worker],
  );

  /**
   * 重抽。
   *
   * 关键是**把这一轮的后台写入一起撤销**：取消排队中的任务，删掉旧回复，
   * 再把已经落盘的情绪变化反向还原。只删消息不撤状态，关系会越抽越高。
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
      for (const message of turnMessages) {
        if (message.role === 'character') await session.deleteMessage(message.id);
      }
      await session.revertTurn(target.turnId);

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

      if (target.role === 'character' && db) {
        await db.queue.cancelByTurn(target.turnId);
        await session.revertTurn(target.turnId);
      }
      await session.deleteMessage(id);
    },
    [db, messages, session],
  );

  const handleStop = useCallback(() => abortRef.current?.abort(), []);
  const disabled = busy || !session.ready;

  return (
    <div className="app">
      <TopBar
        rooms={session.rooms}
        activeRoomId={snapshot?.room.id ?? null}
        personas={personas}
        activePersonaId={activePersona?.id ?? null}
        backendKind={boot?.backendKind ?? ''}
        degraded={boot?.degraded ?? false}
        canStartNewWorld={activeCard !== null}
        disabled={disabled}
        onOpenRoom={(id) => {
          void session.openRoom(id);
          setLastPrompt(null);
        }}
        onDeleteRoom={(id) => void session.deleteRoom(id)}
        onNewWorld={() => {
          if (activeCard) void startNewRoom(activeCard);
        }}
        onSelectPersona={(persona) => void session.setPersona(persona)}
        onReset={() => {
          if (activeCard) void startNewRoom(activeCard);
        }}
      />

      <div className="app-body">
        <DesignSidebar
          cards={session.library.cards}
          worldBooks={session.library.worldBooks}
          attachedWorldBookIds={snapshot?.room.worldBookIds ?? []}
          personas={personas}
          activePersonaId={activePersona?.id ?? null}
          providers={providers}
          disabled={disabled}
          onSaveCard={(card) => void session.saveCard(card)}
          onDeleteCard={(id) => void session.deleteCard(id)}
          onSaveWorldBook={(book) => void session.saveWorldBook(book)}
          onDeleteWorldBook={(id) => void session.deleteWorldBook(id)}
          onAttachWorldBook={(book) => void session.attachWorldBook(book)}
          onSelectPersona={(persona) => void session.setPersona(persona)}
          onSavePersona={(persona) => void session.savePersona(persona)}
          onDeletePersona={(id) => void session.deletePersona(id)}
          onImportFile={(file) => {
            void handleImport(file);
          }}
          notice={{ warnings: warnings.map((item) => item.message), error: error ?? session.error ?? dbError }}
        />

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
        </main>

        <RuntimePanel
          scene={scene}
          instances={snapshot?.instances ?? []}
          memories={snapshot?.memories ?? []}
          attachedWorldBooks={snapshot?.worldBooks ?? []}
          libraryCards={session.library.cards}
          prompt={lastPrompt}
          pending={worker.pending}
          completed={worker.completed}
          workerError={worker.lastError}
          disabled={disabled}
          onSceneChange={(patch) => void session.updateScene(patch)}
          onStartNewScene={(title) => void session.startNewScene(title)}
          onSetPresence={(id, presence) => void session.setPresence(id, presence)}
          onRenameInstance={(id, name) => void session.updateInstance(id, { displayName: name })}
          onRemoveInstance={(id) => void session.removeInstance(id)}
          onAddInstance={(card) => {
            void session.addInstance(card).then(async (instance) => {
              if (!instance || !snapshot || !scene) return;
              const greeting = createGreetingMessage({
                card,
                instance,
                room: snapshot.room,
                scene,
                audience: [...scene.cast, instance.id],
              });
              if (greeting) await session.appendMessages([greeting]);
            });
          }}
          onDetachWorldBook={(id) => void session.detachWorldBook(id)}
          onUpdateMemory={(id, patch) => void session.updateMemory(id, patch)}
          onDeleteMemory={(id) => void session.deleteMemory(id)}
        />
      </div>
    </div>
  );
}
