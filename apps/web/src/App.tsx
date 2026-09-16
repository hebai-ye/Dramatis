import {
  type AssembledPrompt,
  buildSceneTransitionNarration,
  type Card,
  type CharacterInstance,
  type ConversationModes,
  createCharacterMessage,
  createNarrationMessage,
  createOpenAICompatibleProvider,
  createPlayerMessage,
  createTurnId,
  type InstanceId,
  importCardFromJson,
  importCardFromPng,
  type Message,
  type MessageId,
  type MessageUsage,
  matchWorldBookEntries,
  type PromptMemory,
  parseWorldBook,
  type RecalledMemory,
  recallMemories,
  runTurn,
  type Scene,
  scheduleSpeakers,
  selectSceneMembers,
  selectWithinBudget,
  turnsSinceLastSpoke,
} from '@dramatis/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardDesigner } from './components/CardDesigner';
import { CastDetail } from './components/CastDetail';
import { CastRail } from './components/CastRail';
import { LeftRail, type RailPane } from './components/LeftRail';
import { MainChat } from './components/MainChat';
import { MainHeader } from './components/MainHeader';
import { NewConversationDialog } from './components/NewConversationDialog';
import { RuntimePanel } from './components/RuntimePanel';
import { SceneDialog } from './components/SceneDialog';
import { SettingsPanel } from './components/SettingsPanel';
import { SideChat } from './components/SideChat';
import { TopBar } from './components/TopBar';
import { WorldDesigner } from './components/WorldDesigner';
import { WorldTree } from './components/WorldTree';
import { useAdminChat } from './lib/admin';
import { useProviders } from './lib/providers';
import { useDatabase, useSession } from './lib/session';
import { AFFECT_TASK_KIND, MEMORY_BUDGET_TOKENS, MEMORY_TASK_KIND, useBackgroundWorker } from './lib/worker';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 界面上的提示条：导入警告与归档结果都走这一种形状。 */
interface Notice {
  code: string;
  message: string;
}

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

/**
 * 应用外壳（LAYOUT 的骨架）。
 *
 * 顶栏只放折叠按钮，其余留给未来的世界视图；左栏分三段；主区是
 * 「标题栏 + 对话 + 输入区」加右缘的角色栏。会话状态与回合逻辑都留在这里，
 * 各区域各自只管自己那一块。
 */
export function App() {
  const { db, boot, error: dbError } = useDatabase();
  const session = useSession(db);
  const providers = useProviders(db);

  const worker = useBackgroundWorker({
    db,
    provider: providers.background,
    onChanged: () => {
      void session.reloadWorld();
    },
  });

  const admin = useAdminChat({
    db,
    session,
    providers,
    onChanged: () => {
      void session.reloadWorld();
    },
  });

  const [collapsed, setCollapsed] = useState(false);
  const [pane, setPane] = useState<RailPane>('list');
  const [panelOpen, setPanelOpen] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [detailId, setDetailId] = useState<InstanceId | null>(null);

  const [warnings, setWarnings] = useState<Notice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamSpeaker, setStreamSpeaker] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<AssembledPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const world = session.world;
  const conversation = session.conversation;
  const scene = session.scene;
  const messages = session.messages;
  const instances = session.instances;
  const personas = session.personas;

  const activePersona = personas.find((persona) => persona.id === world?.personaId) ?? null;
  const ready = world !== null && conversation !== null;
  const archived = conversation?.archivedAt != null;
  const isSide = conversation?.kind === 'side';

  /** 此刻在场的人，标题栏与旁白都用它。 */
  const cast = useMemo(
    () => (scene === null ? [] : instances.filter((instance) => scene.cast.includes(instance.id))),
    [instances, scene],
  );

  const availableCards = useMemo(
    () => session.library.cards.filter((card) => !instances.some((instance) => instance.cardId === card.id)),
    [instances, session.library.cards],
  );

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
    }): Promise<{ text: string; usage: MessageUsage | null }> => {
      const profile = providers.active;
      if (!profile || !world || !scene) return { text: '', usage: null };

      const provider = createOpenAICompatibleProvider({
        baseUrl: profile.baseUrl,
        apiKey: providers.apiKey,
        model: profile.model,
        // 要真实用量：这是 P3-7 的成本统计，也是 P1-9 设熔断阈值的依据
        includeUsage: true,
      });

      // 世界书按关键词命中插入，扫描范围是玩家输入加最近几轮
      const scanText = [options.playerInput, ...options.history.slice(-8).map((message) => message.content)].join('\n');
      const worldBookMatches = session.worldBooks.flatMap((book) => matchWorldBookEntries(book, { scanText }));

      let accumulated = '';
      let usage: MessageUsage | null = null;
      for await (const event of runTurn(
        {
          card: options.card,
          instance: options.speaker,
          room: world,
          scene,
          cast: instances,
          history: options.history,
          playerInput: options.playerInput,
          worldBookMatches,
          memories: options.memories === undefined ? [] : [...options.memories],
          modes: conversation?.modes,
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
            usage = event.usage;
            break;
        }
      }
      return { text: accumulated, usage };
    },
    [conversation, instances, providers, scene, session.worldBooks, world],
  );

  const makeCharacterLine = useCallback(
    (speaker: CharacterInstance, content: string, turnId: string, sceneValue: Scene): Message =>
      createCharacterMessage({
        roomId: sceneValue.roomId,
        conversationId: sceneValue.conversationId,
        sceneId: sceneValue.id,
        turnId,
        speakerInstanceId: speaker.id,
        speakerName: speaker.displayName,
        content,
        audience: sceneValue.cast,
      }),
    [],
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

        // 一张卡都没有的时候，导入即开一条新世界线，省掉一步
        if (session.world === null) {
          await session.createWorld({ title: result.card.name, persona: activePersona, cards: [result.card] });
        }

        if (result.card.embeddedWorldBook !== null) {
          const { book } = parseWorldBook(result.card.embeddedWorldBook, `${result.card.name} 的内嵌世界书`);
          await session.saveWorldBook(book);
          await session.attachWorldBook(book);
        }
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : String(importError));
      }
    },
    [activePersona, session],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!db || !world || !scene || !conversation || busy) return;

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
      setStreamSpeaker('');
      setReasoningText('');

      const turnId = createTurnId();
      const history = messages;

      const playerMessage = createPlayerMessage({
        roomId: world.id,
        conversationId: conversation.id,
        sceneId: scene.id,
        turnId,
        speakerName: world.playerName,
        content: text,
        audience: scene.cast,
      });
      await session.appendMessages([playerMessage]);

      const controller = new AbortController();
      abortRef.current = controller;
      let continuedHistory: Message[] = [...history, playerMessage];

      try {
        const since = turnsSinceLastSpoke(history, turnId);
        const schedule = scheduleSpeakers({
          playerInput: text,
          candidates: instances.map((instance) => ({
            instance,
            turnsSinceSpoke: since.get(instance.id) ?? null,
          })),
          // 名单以当前场景为准：presence 是「他在这个世界的状态」，
          // 而多条对话并存时，onstage 的角色未必在这条线的这场戏里
          cast: scene.cast,
          maxSpeakers: 1,
        });

        let first = true;
        for (const speakerId of schedule.speakers) {
          const speaker = instances.find((item) => item.id === speakerId);
          if (!speaker) continue;
          const speakerCard = session.cards.find((item) => item.id === speaker.cardId);
          if (!speakerCard) continue;

          // 只召回这个人自己的视角条目
          const now = new Date().toISOString();
          const recalled = selectWithinBudget(
            recallMemories(session.memories, {
              observerId: speaker.id,
              text: [text, ...history.slice(-6).map((message) => message.content)].join('\n'),
              participantIds: scene.cast,
              location: scene.location,
              now,
            }),
            MEMORY_BUDGET_TOKENS,
          );

          setStreamSpeaker(speaker.displayName);
          const generation = await runGeneration({
            speaker,
            card: speakerCard,
            history: first ? history : continuedHistory,
            playerInput: first ? text : '',
            memories: recalled.map(toPromptMemory),
            showStream: true,
            signal: controller.signal,
          });
          const reply = generation.text;
          first = false;

          if (recalled.length > 0) {
            void session.markRecalled(
              recalled.map((item) => item.event),
              now,
            );
          }

          if (reply.trim() !== '') {
            const line: Message = {
              ...makeCharacterLine(speaker, reply, turnId, scene),
              // 用量挂在消息上：刷新之后仍然能看见这一轮花了多少
              ...(generation.usage === null ? {} : { usage: generation.usage }),
            };
            await session.appendMessages([line]);
            continuedHistory = [...continuedHistory, line];
          }
        }

        // 抽成两块后台任务，不阻塞对话；负载只存 id，内容现取
        const payload = { roomId: world.id, sceneId: scene.id, turnId, conversationId: conversation.id };
        for (const kind of [MEMORY_TASK_KIND, AFFECT_TASK_KIND]) {
          await db.queue.enqueue({
            kind,
            idempotencyKey: `${kind}:${turnId}`,
            roomId: world.id,
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
    [
      busy,
      conversation,
      db,
      instances,
      makeCharacterLine,
      messages,
      providers,
      runGeneration,
      scene,
      session,
      worker,
      world,
    ],
  );

  /**
   * 重抽。
   *
   * 关键是**把这一轮的后台写入一起撤销**：取消排队中的任务，删掉旧回复，
   * 再把已经落盘的情绪变化反向还原。只删消息不撤状态，关系会越抽越高。
   */
  const handleRegenerate = useCallback(
    async (id: MessageId) => {
      if (!db || !world || !scene || !conversation || busy) return;

      const target = messages.find((message) => message.id === id);
      if (!target) return;

      const turnMessages = messages.filter((message) => message.turnId === target.turnId);
      const playerMessage = turnMessages.find((message) => message.role === 'player');
      if (!playerMessage) {
        setError('这一轮找不到对应的玩家发言，无法重抽');
        return;
      }

      const speaker = instances.find((item) => item.id === target.speakerInstanceId);
      const speakerCard = speaker ? session.cards.find((item) => item.id === speaker.cardId) : null;
      if (!speaker || !speakerCard) {
        setError('找不到这条回复对应的角色');
        return;
      }

      setError(null);
      setBusy(true);
      setStreamText('');
      setReasoningText('');

      // 用 clearTurn 而不是 cancelByTurn：已经跑完的任务记录会占着幂等键，
      // 不清掉的话下面重新入队会被当成重复任务
      await db.queue.clearTurn(target.turnId);
      for (const message of turnMessages) {
        if (message.role === 'character') await session.deleteMessage(message.id);
      }
      await session.revertTurn(target.turnId);

      const earlierHistory = messages.filter((message) => message.turnId !== target.turnId);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const generation = await runGeneration({
          speaker,
          card: speakerCard,
          history: earlierHistory,
          playerInput: playerMessage.content,
          showStream: true,
          signal: controller.signal,
        });

        if (generation.text.trim() !== '') {
          await session.appendMessages([
            {
              ...makeCharacterLine(speaker, generation.text, target.turnId, scene),
              ...(generation.usage === null ? {} : { usage: generation.usage }),
            },
          ]);
        }

        // 重抽撤销了这一轮的后台任务，必须重新排一次队。
        // 不补这一步的话，被重抽的那一轮会永远不再抽取记忆——角色的记忆里
        // 就永久缺了一段（真实模型端到端测试里就是这样发现的：重抽两次之后
        // 记忆条数少了一条，再也没有回来）。
        const payload = {
          roomId: world.id,
          sceneId: scene.id,
          turnId: target.turnId,
          conversationId: conversation.id,
        };
        for (const kind of [MEMORY_TASK_KIND, AFFECT_TASK_KIND]) {
          await db.queue.enqueue({
            kind,
            idempotencyKey: `${kind}:${target.turnId}`,
            roomId: world.id,
            turnId: target.turnId,
            payload,
          });
        }
        worker.kick();
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
    [busy, conversation, db, instances, makeCharacterLine, messages, runGeneration, scene, session, worker, world],
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

  /** 切换场景：开一场新的，并留下一条旁白式动作（谁跟谁去了哪里）。 */
  const handleStartNewScene = useCallback(
    async (input: { title: string; location: string; worldTime: string }) => {
      if (!world || !conversation) return;

      const created = await session.startNewScene(input);
      if (!created) return;

      const members = selectSceneMembers(instances, created);
      const content = buildSceneTransitionNarration({ next: created, members });

      await session.appendMessages([
        createNarrationMessage({
          roomId: world.id,
          conversationId: conversation.id,
          sceneId: created.id,
          turnId: createTurnId(),
          content,
        }),
      ]);
    },
    [conversation, instances, session, world],
  );

  const handleNewConversation = useCallback(
    async (input: {
      title: string;
      cardIds: string[];
      worldBookIds: string[];
      sceneTitle: string;
      location: string;
      worldTime: string;
    }) => {
      setNewConversationOpen(false);
      const cards = session.library.cards.filter((card) => input.cardIds.includes(card.id));

      // 还没有世界时，「新对话」顺带把世界建起来：否则用户会卡在「没有世界可开线」
      if (session.world === null) {
        await session.createWorld({
          title: input.title,
          persona: activePersona,
          cards,
          worldBookIds: input.worldBookIds as never,
        });
        return;
      }

      await session.startConversation({
        title: input.title,
        cards,
        worldBookIds: input.worldBookIds as never,
        sceneTitle: input.sceneTitle,
        location: input.location,
        worldTime: input.worldTime,
      });
    },
    [activePersona, session],
  );

  /** 「创建」走副对话；还没有世界就先建一个空世界，否则管理员无处落脚。 */
  const handleCreateWithAi = useCallback(async () => {
    if (session.world === null) {
      await session.createWorld({ title: '新世界', persona: activePersona, cards: [] });
    }
    await session.openSideConversation();
    setPane('list');
  }, [activePersona, session]);

  const handleToggleKind = useCallback(async () => {
    if (conversation?.kind === 'side') {
      const main = session.conversations.find((item) => item.kind === 'main');
      if (main) await session.openConversation(main.id);
      return;
    }
    await session.openSideConversation();
  }, [conversation, session]);

  const handleArchive = useCallback(
    async (targetConversationId: string) => {
      const report = await session.archiveConversation(targetConversationId as never);
      if (report === null) return;
      setError(null);
      setWarnings([
        {
          code: 'conversation.archived',
          message: `已归档：回滚了 ${String(report.restoredInstances)} 名角色的状态，撤销了 ${String(
            report.removedMemories,
          )} 条记忆。对话本身保留在设置里。`,
        },
      ]);
    },
    [session],
  );

  const handleToggleMode = useCallback(
    (key: keyof ConversationModes, value: boolean) => {
      if (!conversation) return;
      void session.updateConversation({ modes: { ...conversation.modes, [key]: value } });
    },
    [conversation, session],
  );

  const disabled = busy || !session.ready;
  const detail = detailId === null ? null : (instances.find((instance) => instance.id === detailId) ?? null);
  const worldId = world?.id ?? null;

  // 换世界时把选中态清掉，避免看到上一个世界的角色详情
  useEffect(() => {
    if (worldId === null) return;
    setDetailId(null);
  }, [worldId]);

  return (
    <div className="app">
      <TopBar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        backendKind={boot?.backendKind ?? ''}
        degraded={boot?.degraded ?? false}
        backgroundPending={worker.pending}
      />

      <div className={collapsed ? 'app-body collapsed' : 'app-body'}>
        {collapsed ? null : (
          <LeftRail
            pane={pane}
            onPaneChange={setPane}
            onNewConversation={() => setNewConversationOpen(true)}
            onCreateWithAi={() => void handleCreateWithAi()}
            onImportFile={(file) => void handleImport(file)}
            disabled={disabled}
            list={
              <>
                {error !== null || dbError !== null || session.error !== null ? (
                  <div className="notice error">
                    <strong>出错了</strong>
                    <p>{error ?? session.error ?? dbError}</p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setError(null);
                        session.clearError();
                      }}
                    >
                      知道了
                    </button>
                  </div>
                ) : null}

                {warnings.length > 0 ? (
                  <div className="notice warn">
                    <strong>提示</strong>
                    <ul>
                      {warnings.map((item, index) => (
                        <li key={`${String(index)}-${item.message.slice(0, 12)}`}>{item.message}</li>
                      ))}
                    </ul>
                    <button type="button" className="ghost" onClick={() => setWarnings([])}>
                      知道了
                    </button>
                  </div>
                ) : null}

                <WorldTree
                  worlds={session.worlds}
                  activeWorldId={world?.id ?? null}
                  conversations={session.conversations}
                  activeConversationId={conversation?.id ?? null}
                  disabled={disabled}
                  onOpenWorld={(id) => void session.openWorld(id)}
                  onOpenConversation={(id) => void session.openConversation(id)}
                  onArchiveConversation={(target) => {
                    if (
                      window.confirm(
                        `归档「${target.title}」？情绪、关系与记忆会回滚到它开始之前，这条时间线相当于没有发生过；对话本身会保留在设置里。`,
                      )
                    ) {
                      void handleArchive(target.id);
                    }
                  }}
                  onDeleteConversation={(target) => void session.deleteConversation(target.id)}
                  onDeleteWorld={(id) => void session.deleteWorld(id)}
                />
              </>
            }
            panel={
              <>
                {pane === 'cards' ? (
                  <section className="panel">
                    <CardDesigner
                      cards={session.library.cards}
                      disabled={disabled}
                      onSave={(card) => void session.saveCard(card)}
                      onDelete={(id) => void session.deleteCard(id)}
                    />
                  </section>
                ) : null}

                {pane === 'worldbooks' ? (
                  <section className="panel">
                    <WorldDesigner
                      books={session.library.worldBooks}
                      attachedIds={world?.worldBookIds ?? []}
                      disabled={disabled}
                      onSave={(book) => void session.saveWorldBook(book)}
                      onDelete={(id) => void session.deleteWorldBook(id)}
                      onAttach={(book) => void session.attachWorldBook(book)}
                    />
                  </section>
                ) : null}

                {pane === 'settings' ? (
                  <SettingsPanel
                    providers={providers}
                    personas={personas}
                    activePersonaId={activePersona?.id ?? null}
                    archivedConversations={session.archivedConversations}
                    activeConversationId={conversation?.id ?? null}
                    disabled={disabled}
                    onSelectPersona={(persona) => void session.setPersona(persona)}
                    onSavePersona={(persona) => void session.savePersona(persona)}
                    onDeletePersona={(id) => void session.deletePersona(id)}
                    onOpenArchived={(id) => void session.openConversation(id)}
                    onDeleteArchived={(target) => void session.deleteConversation(target.id)}
                  />
                ) : null}
              </>
            }
          />
        )}

        <div className="workspace">
          <MainHeader
            world={world}
            conversation={conversation}
            cast={cast}
            disabled={disabled}
            panelOpen={panelOpen}
            onToggleKind={() => void handleToggleKind()}
            onTogglePanel={() => setPanelOpen((value) => !value)}
            onRenameConversation={(title) => void session.updateConversation({ title })}
          />

          {world === null || conversation === null ? (
            <section className="chat-surface empty">
              <p className="hint">还没有打开的对话。</p>
              <p className="hint">
                导入一张角色卡，或者用左栏的「新对话」开一条线；也可以点「创建」让世界管理员陪你起草。
              </p>
            </section>
          ) : (
            <div className="workspace-body">
              {isSide ? (
                <SideChat
                  conversation={conversation}
                  messages={messages}
                  streamText={admin.streamText}
                  busy={admin.busy}
                  ready={ready}
                  archived={archived}
                  onSend={(text) => void admin.send(text)}
                  onStop={admin.stop}
                  onAdopt={(messageId, artifact) => void session.adoptArtifact(messageId, artifact.id)}
                  onDiscard={(messageId, artifact) => void session.discardArtifact(messageId, artifact.id)}
                />
              ) : (
                <MainChat
                  conversation={conversation}
                  scene={scene}
                  messages={messages}
                  cast={cast}
                  streamText={streamText}
                  streamSpeaker={streamSpeaker}
                  reasoningText={reasoningText}
                  busy={busy}
                  ready={ready}
                  archived={archived}
                  onSend={(text) => void handleSend(text)}
                  onStop={() => abortRef.current?.abort()}
                  onRegenerate={(id) => void handleRegenerate(id)}
                  onEdit={(id, content) => void session.updateMessage(id, { content })}
                  onDelete={(id) => void handleDeleteMessage(id)}
                  onToggleMode={handleToggleMode}
                  onOpenScene={() => setSceneOpen(true)}
                  onDropInstance={(id) => void session.setPresence(id, 'onstage')}
                />
              )}

              <div className={panelOpen ? 'runtime-drawer open' : 'runtime-drawer'}>
                {panelOpen ? (
                  <RuntimePanel
                    scene={scene}
                    instances={instances}
                    memories={session.memories}
                    attachedWorldBooks={session.worldBooks}
                    libraryCards={session.library.cards}
                    prompt={lastPrompt}
                    pending={worker.pending}
                    completed={worker.completed}
                    backgroundUsage={worker.usage}
                    workerError={worker.lastError}
                    disabled={disabled}
                    onSceneChange={(patch) => void session.updateScene(patch)}
                    onStartNewScene={(title) => void handleStartNewScene({ title, location: '', worldTime: '' })}
                    onSetPresence={(id, presence) => void session.setPresence(id, presence)}
                    onRenameInstance={(id, name) => void session.updateInstance(id, { displayName: name })}
                    onRemoveInstance={(id) => void session.removeInstance(id)}
                    onAddInstance={(card) => void session.addInstance(card)}
                    onDetachWorldBook={(id) => void session.detachWorldBook(id)}
                    onUpdateMemory={(id, patch) => void session.updateMemory(id, patch)}
                    onDeleteMemory={(id) => void session.deleteMemory(id)}
                  />
                ) : null}
              </div>
            </div>
          )}

          {!isSide && world !== null && conversation !== null ? (
            <CastRail
              instances={instances}
              scene={scene}
              cards={session.cards}
              disabled={disabled}
              onOpenDetail={setDetailId}
              availableCards={availableCards}
              onAddInstance={(card) => void session.addInstance(card)}
            />
          ) : null}
        </div>
      </div>

      {newConversationOpen ? (
        <NewConversationDialog
          cards={session.library.cards}
          worldBooks={session.library.worldBooks}
          defaultCardIds={instances.map((instance) => instance.cardId)}
          attachedBookIds={world?.worldBookIds ?? []}
          disabled={disabled}
          onClose={() => setNewConversationOpen(false)}
          onSubmit={(input) => void handleNewConversation(input)}
        />
      ) : null}

      {sceneOpen ? (
        <SceneDialog
          scene={scene}
          instances={instances}
          disabled={disabled}
          onClose={() => setSceneOpen(false)}
          onSave={(patch) => void session.updateScene(patch)}
          onStartNewScene={(input) => void handleStartNewScene(input)}
        />
      ) : null}

      {detail === null ? null : (
        <CastDetail
          instance={detail}
          card={session.cards.find((card) => card.id === detail.cardId) ?? null}
          memories={session.memories}
          disabled={disabled}
          onClose={() => setDetailId(null)}
          onRename={(id, name) => void session.updateInstance(id, { displayName: name })}
          onSetPresence={(id, presence) => void session.setPresence(id, presence)}
          onRemove={(id) => {
            setDetailId(null);
            void session.removeInstance(id);
          }}
        />
      )}
    </div>
  );
}
