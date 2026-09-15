import {
  createCharacterMessage,
  createGreetingMessage,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  importCardFromJson,
  importCardFromPng,
  runTurn,
  type AssembledPrompt,
  type Card,
  type ImportWarning,
  type Message,
  type Scene,
} from '@dramatis/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CardPanel } from './components/CardPanel';
import { ChatPanel } from './components/ChatPanel';
import { PromptInspector } from './components/PromptInspector';
import { ScenePanel } from './components/ScenePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { createWorldFromCard, type World } from './lib/world';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [card, setCard] = useState<Card | null>(null);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [world, setWorld] = useState<World | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamText, setStreamText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((previous) => ({ ...previous, ...patch }));
    if (patch.playerName !== undefined) {
      setWorld((previous) =>
        previous === null
          ? previous
          : {
              ...previous,
              room: {
                ...previous.room,
                playerName: patch.playerName?.trim() === '' ? '玩家' : (patch.playerName ?? '玩家'),
              },
            },
      );
    }
  }, []);

  const startWorld = useCallback((nextCard: Card, playerName: string) => {
    const nextWorld = createWorldFromCard(nextCard, playerName);
    setWorld(nextWorld);
    const greeting = createGreetingMessage({
      card: nextCard,
      instance: nextWorld.instance,
      room: nextWorld.room,
      scene: nextWorld.scene,
    });
    setMessages(greeting ? [greeting] : []);
    setLastPrompt(null);
  }, []);

  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = looksLikePng(bytes)
          ? await importCardFromPng(bytes, file.name)
          : importCardFromJson(new TextDecoder('utf-8').decode(bytes), file.name);

        setCard(result.card);
        setWarnings(result.warnings);
        startWorld(result.card, settings.playerName);
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
        setCard(null);
        setWorld(null);
        setMessages([]);
      }
    },
    [settings.playerName, startWorld],
  );

  const handleReset = useCallback(() => {
    if (card) startWorld(card, settings.playerName);
  }, [card, settings.playerName, startWorld]);

  const handleSceneChange = useCallback((patch: Partial<Scene>) => {
    setWorld((previous) =>
      previous === null ? previous : { ...previous, scene: { ...previous.scene, ...patch } },
    );
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      if (card === null || world === null || busy) return;

      const content = text.trim();
      if (content === '') return;

      setError(null);
      setBusy(true);
      setStreamText('');
      setReasoningText('');

      const turnId = createTurnId();
      const history = messages;
      setMessages((previous) => [
        ...previous,
        createPlayerMessage({
          roomId: world.room.id,
          sceneId: world.scene.id,
          turnId,
          speakerName: world.room.playerName,
          content,
        }),
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = '';

      try {
        const provider = createOpenAICompatibleProvider({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
        });

        for await (const event of runTurn(
          {
            card,
            instance: world.instance,
            room: world.room,
            scene: world.scene,
            history,
            playerInput: content,
            budget: {
              maxTokens: settings.maxTokens,
              reserveForReply: settings.reserveForReply,
            },
          },
          provider,
          {
            params: { temperature: settings.temperature },
            signal: controller.signal,
          },
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
          const reply = accumulated;
          setMessages((previous) => [
            ...previous,
            createCharacterMessage({
              roomId: world.room.id,
              sceneId: world.scene.id,
              turnId,
              speakerInstanceId: world.instance.id,
              speakerName: world.instance.displayName,
              content: reply,
            }),
          ]);
        }
        setStreamText('');
        setReasoningText('');
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, card, messages, settings, world],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>Dramatis</h1>
          <span>登场 · M0</span>
        </header>
        <CardPanel
          card={card}
          warnings={warnings}
          error={error}
          disabled={busy}
          onImport={(file) => {
            void handleImport(file);
          }}
        />
        {world ? <ScenePanel scene={world.scene} disabled={busy} onChange={handleSceneChange} /> : null}
        <SettingsPanel settings={settings} disabled={busy} onChange={updateSettings} />
      </aside>

      <main className="main">
        <ChatPanel
          messages={messages}
          streamText={streamText}
          reasoningText={reasoningText}
          busy={busy}
          ready={card !== null && world !== null}
          characterName={world?.instance.displayName ?? ''}
          onSend={(text) => {
            void handleSend(text);
          }}
          onStop={handleStop}
          onReset={handleReset}
        />
        <PromptInspector prompt={lastPrompt} />
      </main>
    </div>
  );
}
