import {
  type AssembledPrompt,
  type Card,
  createCharacterMessage,
  createGreetingMessage,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  type ImportWarning,
  importCardFromJson,
  importCardFromPng,
  runTurn,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CardPanel } from './components/CardPanel';
import { ChatPanel } from './components/ChatPanel';
import { PromptInspector } from './components/PromptInspector';
import { ProviderPanel } from './components/ProviderPanel';
import { RoomPanel } from './components/RoomPanel';
import { ScenePanel } from './components/ScenePanel';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const META_PLAYER_NAME = 'player.name';

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function App() {
  const { db, boot, error: dbError } = useDatabase();
  const session = useSession(db);
  const providers = useProviders(db);

  const [importedCard, setImportedCard] = useState<Card | null>(null);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);
  const [playerName, setPlayerName] = useState('玩家');
  const abortRef = useRef<AbortController | null>(null);

  const snapshot = session.snapshot;
  const activeCard = snapshot?.cards.find((item) => item.id === snapshot.room.cardIds[0]) ?? importedCard;
  const instance = snapshot?.instances[0] ?? null;
  const scene = session.activeScene;
  const messages = snapshot?.messages ?? [];
  const ready = activeCard !== null && instance !== null && scene !== null;

  // 玩家 persona 是跨房间的偏好，存在 meta 里
  useEffect(() => {
    if (!db) return;
    void db.repository.getMeta<string>(META_PLAYER_NAME).then((value) => {
      if (typeof value === 'string' && value.trim() !== '') setPlayerName(value);
    });
  }, [db]);

  const handlePlayerNameChange = useCallback(
    (value: string) => {
      setPlayerName(value);
      void db?.repository.setMeta(META_PLAYER_NAME, value);
    },
    [db],
  );

  /** 用一张卡开一条新世界线，并写入角色的开场白。 */
  const startNewRoom = useCallback(
    async (target: Card) => {
      const created = await session.createRoom(target, playerName);
      const createdInstance = created?.instances[0];
      if (!created || !createdInstance) return;

      const greeting = createGreetingMessage({
        card: target,
        instance: createdInstance,
        room: created.room,
        scene: created.scenes.find((item) => item.id === created.room.activeSceneId) ?? null,
      });
      if (greeting) await session.appendMessages([greeting]);
      setLastPrompt(null);
    },
    [playerName, session],
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
        await startNewRoom(result.card);
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    },
    [startNewRoom],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!db || !snapshot || !activeCard || !instance || !scene || busy) return;

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

      await session.appendMessages([
        createPlayerMessage({
          roomId: snapshot.room.id,
          sceneId: scene.id,
          turnId,
          speakerName: snapshot.room.playerName,
          content: text,
        }),
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      let accumulated = '';

      try {
        const provider = createOpenAICompatibleProvider({
          baseUrl: profile.baseUrl,
          apiKey: providers.apiKey,
          model: profile.model,
        });

        for await (const event of runTurn(
          {
            card: activeCard,
            instance,
            room: snapshot.room,
            scene,
            history,
            playerInput: text,
            budget: { maxTokens: profile.maxTokens, reserveForReply: profile.reserveForReply },
          },
          provider,
          { params: { temperature: profile.temperature }, signal: controller.signal },
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
              setStreamText(accumulated);
              break;
            case 'done':
              accumulated = event.text;
              break;
          }
        }
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : String(sendError);
        setError(controller.signal.aborted ? `已停止生成（${message}）` : message);
      } finally {
        if (accumulated.trim() !== '') {
          // 生成中断时也把已产出的部分落盘，避免用户白等
          await session.appendMessages([
            createCharacterMessage({
              roomId: snapshot.room.id,
              sceneId: scene.id,
              turnId,
              speakerInstanceId: instance.id,
              speakerName: instance.displayName,
              content: accumulated,
            }),
          ]);
        }
        setStreamText('');
        setReasoningText('');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [activeCard, busy, db, instance, messages, providers, scene, session, snapshot],
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
          playerName={playerName}
          onPlayerNameChange={handlePlayerNameChange}
          disabled={busy || !session.ready}
          onOpen={(id) => {
            void session.openRoom(id);
            setLastPrompt(null);
          }}
          onDelete={(id) => void session.deleteRoom(id)}
        />

        <CardPanel
          card={activeCard}
          warnings={warnings}
          error={displayError}
          disabled={busy || !session.ready}
          onImport={(file) => {
            void handleImport(file);
          }}
        />

        {scene ? (
          <ScenePanel scene={scene} disabled={busy} onChange={(patch) => void session.updateScene(patch)} />
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
          characterName={instance?.displayName ?? ''}
          onSend={(text) => {
            void handleSend(text);
          }}
          onStop={handleStop}
          onReset={() => {
            if (activeCard) void startNewRoom(activeCard);
          }}
        />
        <PromptInspector prompt={lastPrompt} />
      </main>
    </div>
  );
}
