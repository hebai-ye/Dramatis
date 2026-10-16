/**
 * Memory-only Node/React SSR benchmark and optional disposable browser QA archives.
 * Run from repository root: node apps/web/tools/ui-synthetic-benchmark.mjs --output build/.../after.json
 * --source selects a read-only checkout. No Vite config/backend, HTTP listener, IndexedDB or model is used.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

process.env.NODE_ENV = 'production';

const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const archiveOnly = args.includes('--archives-only');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const sourceRoot = resolve(option('--source', taskRoot));
const sourceRequire = createRequire(join(sourceRoot, 'apps/web/package.json'));
const { createElement } = sourceRequire('react');
const { renderToStaticMarkup } = sourceRequire('react-dom/server');
const repetitions = Number(option('--repetitions', '7'));
assert(Number.isInteger(repetitions) && repetitions >= 5, 'Use at least five repetitions');
const output = resolve(option('--output', join(taskRoot, 'build/ui-optimization-20261012/benchmark-after.json')));
const archivesDirectory = option('--archives', null);
const AT = '2026-10-12T00:00:00.000Z';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(JSON.stringify(value));
const relativeName = (path, root) =>
  path
    .slice(root.length + 1)
    .split(sep)
    .join('/');
function walk(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const next = join(path, entry.name);
    return entry.isDirectory() ? walk(next) : [next];
  });
}
function sourceHashes() {
  const paths = [...walk(join(sourceRoot, 'packages/core/src')), ...walk(join(sourceRoot, 'apps/web/src'))]
    .filter((path) => ['.ts', '.tsx', '.txt'].includes(extname(path)))
    .sort();
  return Object.fromEntries(paths.map((path) => [relativeName(path, sourceRoot), sha256(readFileSync(path))]));
}
function artifactBytes() {
  const dist = join(sourceRoot, 'apps/web/dist');
  const htmlPath = join(dist, 'index.html');
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, 'utf8');
  const urls = [
    ...new Set(
      [
        ...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g),
        ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g),
      ].map((match) => match[1]),
    ),
  ];
  const initial = urls.map((url) => join(dist, url.replace(/^\/+/, '')));
  const all = walk(dist).filter((path) => ['.js', '.css'].includes(extname(path)));
  const count = (paths) => ({
    files: paths.length,
    bytes: paths.reduce((total, path) => total + readFileSync(path).length, 0),
    gzipPerFileBytes: paths.reduce((total, path) => total + gzipSync(readFileSync(path)).length, 0),
  });
  return {
    note: 'File bytes and per-file gzip estimates only; not transfer timing or total offline assets. May reflect existing dist.',
    htmlSha256: sha256(html),
    initialJs: count(initial),
    allJsCss: count(all),
  };
}
function makeFixture(core, large = true) {
  const cardCount = large ? 1000 : 3;
  const messageCount = large ? 3000 : 30;
  const memoryCount = large ? 5000 : 12;
  const usageCount = large ? 50000 : 24;
  const cards = Array.from({ length: cardCount }, (_, index) =>
    core.createBlankCard({
      id: `qa-card-${index}`,
      name:
        index === 0
          ? '合成长名角色·码头记录员·用于检查窄屏文字与角色详情入口'
          : index <= 2
            ? '同名角色'
            : `合成角色 ${index}`,
      nickname: `合成 ${index}`,
      description:
        index % 2 === 0 ? '码头合成素材，测试数据可删除。'.repeat(8) : '山路合成素材，测试数据可删除。'.repeat(8),
      personality: '只用于本机界面验证。',
      creator: 'synthetic-ui-qa',
      characterVersion: '1',
      tags: [index % 2 === 0 ? '码头' : '山路', '假数据'],
      source: { kind: 'manual', spec: 'dramatis', specVersion: '1', importedAt: AT },
      createdAt: AT,
      updatedAt: new Date(Date.parse(AT) + index * 1000).toISOString(),
    }),
  );
  const persona = core.createPersona({ name: '合成玩家', description: '本机 QA 假数据，可删除。' });
  const world = core.createWorldFromCard(cards[0], persona);
  const instances = [world.instance, ...cards.slice(1, 3).map((card) => core.createInstanceFor(card, world.room.id))];
  let room = {
    ...world.room,
    title: large ? '合成大库·3000消息' : '合成验收世界·可删除',
    cardIds: cards.map((card) => card.id),
    instanceIds: instances.map((instance) => instance.id),
  };
  const conversations = [{ ...world.conversation, title: '同名主对话', kind: 'main' }];
  const scenes = [
    {
      ...world.scene,
      title: '合成码头场景',
      location: '合成码头',
      cast: instances.map((instance) => instance.id),
      summary: '只用于 QA 的场景说明。',
    },
  ];
  for (const [title, kind] of [
    ['同名主对话', 'main'],
    ['合成副对话', 'side'],
    ['已归档合成对话', 'main'],
  ]) {
    const plan = core.planNewConversation({
      room,
      existingInstances: instances,
      cast: instances,
      title,
      kind,
      sceneTitle: '合成场景',
      location: '合成码头',
    });
    room = plan.room;
    conversations.push({ ...plan.conversation, archivedAt: title.startsWith('已归档') ? AT : null });
    scenes.push(plan.scene);
  }
  room.activeConversationId = conversations[0].id;
  const ids = new Map([
    [persona.id, 'qa-persona'],
    [room.id, 'qa-room'],
    ...instances.map((instance, index) => [instance.id, `qa-instance-${index}`]),
    ...conversations.map((conversation, index) => [conversation.id, `qa-conversation-${index}`]),
    ...scenes.map((scene, index) => [scene.id, `qa-scene-${index}`]),
  ]);
  const normalize = (value, key = '') => {
    if (typeof value === 'string') {
      if (['createdAt', 'updatedAt', 'importedAt'].includes(key)) return AT;
      return ids.get(value) ?? value;
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([itemKey, item]) => [ids.get(itemKey) ?? itemKey, normalize(item, itemKey)]),
      );
    return value;
  };
  const base = normalize({ room, scenes, conversations, instances, persona });
  const messages = Array.from({ length: messageCount }, (_, index) => {
    // Large chat remains all in the first conversation; small QA includes two mains, side, and archive.
    const conversationIndex = large ? 0 : index < 12 ? 0 : index < 22 ? 1 : index < 26 ? 2 : 3;
    const speaker = base.instances[Math.floor(index / 2) % base.instances.length];
    const at = new Date(Date.parse(AT) + index * 1000).toISOString();
    const role = index % 2 === 0 ? 'player' : conversationIndex === 2 ? 'admin' : 'character';
    return {
      id: `qa-message-${index}`,
      roomId: base.room.id,
      conversationId: base.conversations[conversationIndex].id,
      sceneId: base.scenes[conversationIndex].id,
      turnId: `qa-turn-${Math.floor(index / 2)}`,
      localSeq: index + 1,
      deviceId: 'synthetic-ui-qa',
      role,
      speakerInstanceId: role === 'character' ? speaker.id : null,
      speakerName: role === 'player' ? '合成玩家' : role === 'admin' ? '世界管理员' : speaker.displayName,
      audience: base.instances.map((instance) => instance.id),
      content:
        role === 'player'
          ? `合成问题 ${index}：码头的箱子放在哪里？`
          : `# 合成角色把灯放到桌上。\n这是可以删除的合成回复 ${index}${'。窗外风声很轻。'.repeat(4)}`,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      ...(role === 'character'
        ? {
            intent: '合成盘算，只用于测试。',
            intentSource: 'declared',
            usage: { promptTokens: 1200, completionTokens: 180 },
          }
        : {}),
    };
  });
  const memories = Array.from({ length: memoryCount }, (_, index) => {
    const observer = index % 4 === 0 ? null : base.instances[(index % 4) - 1].id;
    const at = new Date(Date.parse(AT) + index * 1000).toISOString();
    return {
      id: `qa-memory-${index}`,
      roomId: base.room.id,
      conversationId: base.conversations[large ? 0 : index < 8 ? 0 : 1].id,
      sceneId: base.scenes[large ? 0 : index < 8 ? 0 : 1].id,
      timeline: { worldTime: `合成日·${Math.floor(index / 4)}`, sequence: Math.floor(index / 4) },
      location: '合成码头',
      participants: base.instances.map((instance) => instance.id),
      summary: `合成记忆 ${index}：箱子在东侧库房，仅用于界面验证。`,
      observerId: observer,
      perception: observer === null ? '' : '合成主观感受。',
      importance: 0.5,
      pinned: index % 23 === 0,
      importanceLocked: false,
      affects: [],
      sourceTurnIds: [`qa-turn-${Math.floor(index / 4)}`],
      createdAt: at,
      updatedAt: at,
      lastRecalledAt: null,
      recallCount: 0,
      deletedAt: null,
    };
  });
  if (!large) {
    // A turn with subjective entries but no objective entry; no fabricated objective row.
    memories[8].observerId = base.instances[0].id;
    memories[8].perception = '只有主观记录的合成回合。';
    memories[8].sourceTurnIds = ['qa-missing-objective-turn'];
    memories[9].sourceTurnIds = ['qa-missing-objective-turn'];
    memories[10].supersedes = ['qa-memory-8', 'qa-missing-source'];
    memories[10].summary = '这个角色的合成主观印象。';
  }
  const usageRecords = Array.from({ length: usageCount }, (_, index) => {
    const at = new Date(Date.parse(AT) + index * 1000).toISOString();
    const categories = ['generation', 'intent', 'analysis', 'summary', 'admin'];
    return {
      id: `qa-usage-${index}`,
      roomId: base.room.id,
      conversationId: base.conversations[index % 2].id,
      turnId: `qa-turn-${Math.floor(index / 5)}`,
      category: categories[index % categories.length],
      model: `synthetic-model-${index % 4}`,
      promptTokens: 1200 + (index % 400),
      completionTokens: 180 + (index % 80),
      promptEstimate: 1100 + (index % 400),
      speakerInstanceId: base.instances[index % 3].id,
      speakerName: base.instances[index % 3].displayName,
      price:
        index % 7 === 0 ? null : { inputPerMillion: 1, outputPerMillion: 2, currency: index % 2 === 0 ? '¥' : '$' },
      createdAt: at,
      updatedAt: at,
    };
  });
  return { ...base, cards, messages, memories, usageRecords, chapters: [], worldBooks: [] };
}
const voidHandler = () => {};
const handlers = {
  onContextMenu: voidHandler,
  onPressStart: voidHandler,
  onPressCancel: voidHandler,
  onClickCapture: voidHandler,
  onStartEdit: voidHandler,
  onCancelEdit: voidHandler,
  onEdit: voidHandler,
  onRegenerate: voidHandler,
  onDelete: voidHandler,
  onReassign: voidHandler,
};
async function inMemoryFixture(core) {
  const fixture = makeFixture(core);
  const store = core.createMemoryEntityStore();
  await store.bulkPut(core.USAGE_COLLECTION, fixture.usageRecords);
  return { ...fixture, ledger: core.createUsageLedger(store) };
}
const cacheDirectory = mkdtempSync(join(tmpdir(), 'dramatis-ui-benchmark-'));
let server;
try {
  const hashesBefore = sourceHashes();
  server = await createServer({
    root: join(sourceRoot, 'apps/web'),
    configFile: false,
    envFile: false,
    mode: 'production',
    cacheDir: cacheDirectory,
    logLevel: 'error',
    plugins: [react()],
    define: { 'import.meta.env.DEV': 'false' },
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['@dramatis/core'] },
  });
  const core = await server.ssrLoadModule(join(sourceRoot, 'packages/core/src/index.ts').replaceAll('\\', '/'));
  const { MessageList } = await server.ssrLoadModule('/src/components/MessageItem.tsx');
  const { MemoryPanel } = await server.ssrLoadModule('/src/components/MemoryPanel.tsx');
  const { filterCards } = await server.ssrLoadModule('/src/lib/library-query.ts');
  const scenarios = [
    {
      name: 'message-list-ssr-3000',
      run: (fixture) => {
        const html = renderToStaticMarkup(
          createElement(MessageList, {
            messages: fixture.messages,
            cast: fixture.instances,
            avatars: {},
            lastCharacterId: fixture.messages.at(-1).id,
            editingId: null,
            highlightId: null,
            menuFor: null,
            showIntent: false,
            archived: false,
            manualMode: true,
            signatures: [],
            handlers,
          }),
        );
        const rows = [...html.matchAll(/<article\b/g)].length;
        assert.equal(rows, 3000);
        return { rows, htmlBytes: Buffer.byteLength(html), htmlSha256: sha256(html) };
      },
    },
    {
      name: 'library-filter-sort-1000',
      run: (fixture) => {
        const filtered = filterCards(fixture.cards, '码头', 'name');
        assert.equal(filtered.length, 500);
        return { rows: filtered.length, idsSha256: digest(filtered.map((item) => item.id)) };
      },
    },
    {
      name: 'memory-filter-group-5000',
      run: (fixture) => {
        const counts = core.countByConversation(fixture.memories);
        const filtered = core.filterMemories(fixture.memories, { conversationId: core.ALL, observerId: core.ALL });
        const groups = core.groupMemoriesByTurn(filtered);
        assert.equal(filtered.length, 5000);
        assert.equal(groups.length, 1250);
        assert.equal(
          [...counts.values()].reduce((total, value) => total + value, 0),
          5000,
        );
        return { rows: filtered.length, groups: groups.length, firstGroup: groups[0].key };
      },
    },
    {
      name: 'memory-panel-ssr-5000',
      run: (fixture) => {
        const html = renderToStaticMarkup(
          createElement(MemoryPanel, {
            memories: fixture.memories,
            instances: fixture.instances,
            conversations: fixture.conversations,
            activeConversationId: null,
            pending: 0,
            extraCalls: 0,
            chapters: [],
            cards: [],
            workerError: null,
            disabled: false,
            onUpdate: voidHandler,
            onDelete: voidHandler,
            onLocate: voidHandler,
          }),
        );
        const rows = [...html.matchAll(/<li\b/g)].length;
        assert.equal(rows, 5000);
        return { rows, htmlBytes: Buffer.byteLength(html), htmlSha256: sha256(html) };
      },
    },
    {
      name: 'ledger-scope-memory-read-50000',
      run: async (fixture) => {
        const result = await fixture.ledger.scopeSummary({
          roomId: fixture.room.id,
          conversationId: fixture.conversations[0].id,
          turnId: 'qa-turn-0',
        });
        assert.equal(result.world.total.calls, 50000);
        assert.equal(result.conversation.total.calls, 25000);
        assert.equal(result.latestTurn.total.calls, 3);
        return {
          worldCalls: result.world.total.calls,
          conversationCalls: result.conversation.total.calls,
          latestTurnCalls: result.latestTurn.total.calls,
        };
      },
    },
  ];
  const results = [];
  let fixtureHash;
  for (const phase of archiveOnly ? [] : ['fresh-memory-fixture', 'warmed-runtime']) {
    const warmed = phase === 'warmed-runtime' ? await inMemoryFixture(core) : null;
    if (warmed !== null) {
      for (let warmup = 0; warmup < 2; warmup += 1) {
        for (const scenario of scenarios) await scenario.run(warmed);
      }
    }
    const observations = new Map(scenarios.map((scenario) => [scenario.name, { samplesMs: [], outputs: [] }]));
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const fixture = warmed ?? (await inMemoryFixture(core));
      const hash = digest({
        messages: fixture.messages,
        cards: fixture.cards,
        memories: fixture.memories,
        usageRecords: fixture.usageRecords,
      });
      fixtureHash ??= hash;
      assert.equal(hash, fixtureHash, 'Every repetition must use identical deterministic fixture data');
      for (const scenario of scenarios) {
        const started = performance.now();
        const result = await scenario.run(fixture);
        const elapsed = performance.now() - started;
        const observation = observations.get(scenario.name);
        observation.samplesMs.push(elapsed);
        observation.outputs.push(result);
      }
      process.stdout.write(`${phase}: ${iteration + 1}/${repetitions}\n`);
    }
    for (const scenario of scenarios) {
      const observation = observations.get(scenario.name);
      const sorted = [...observation.samplesMs].sort((left, right) => left - right);
      for (const result of observation.outputs)
        assert.deepEqual(result, observation.outputs[0], 'Stable output across repetitions');
      const middle = Math.floor(sorted.length / 2);
      results.push({
        phase,
        scenario: scenario.name,
        repetitions,
        medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
        worstMs: sorted.at(-1),
        samplesMs: observation.samplesMs,
        output: observation.outputs[0],
      });
    }
  }
  const archiveReports = [];
  if (archivesDirectory !== null) {
    const archiveRoot = resolve(archivesDirectory);
    mkdirSync(archiveRoot, { recursive: true });
    for (const [name, large] of [
      ['qa-small-world.json', false],
      ['qa-large-world.json', true],
    ]) {
      const fixture = makeFixture(core, large);
      // Browser QA needs a representative bill, while the benchmark separately measures all 50k rows.
      const archive = core.buildWorldArchive({
        ...fixture,
        usageRecords: large ? fixture.usageRecords.slice(0, 500) : fixture.usageRecords,
        at: AT,
      });
      const json = JSON.stringify(archive);
      const parsed = core.parseWorldArchive(json);
      assert.equal(parsed.ok, true);
      const store = core.createMemoryEntityStore();
      const repository = new core.Repository(store);
      await repository.migrate();
      const imported = await core.importWorldArchive(parsed.archive, repository, {
        ledger: core.createUsageLedger(store),
        at: AT,
      });
      const loaded = await repository.loadRoom(imported.roomId);
      assert.equal(loaded.messages.length, fixture.messages.length);
      assert.equal(loaded.memories.length, fixture.memories.length);
      assert.equal(loaded.instances.length, fixture.instances.length);
      const path = join(archiveRoot, name);
      writeFileSync(path, `${json}\n`);
      archiveReports.push({
        path,
        bytes: Buffer.byteLength(`${json}\n`),
        sha256: sha256(`${json}\n`),
        counts: core.countArchive(archive),
        importVerified: true,
      });
    }
  }
  const hashesAfter = sourceHashes();
  assert.deepEqual(hashesAfter, hashesBefore, 'Benchmark source must remain unchanged during measurements');
  const report = {
    measuredAt: new Date().toISOString(),
    runKind: archiveOnly ? 'archives-only; no timed measurements' : 'synthetic-benchmark',
    sourceRoot,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, reactBuild: 'production' },
    method: {
      timing: 'performance.now around real core computation / Node React renderToStaticMarkup only',
      repetitions,
      warmups: 2,
      phases:
        'Fresh memory fixture creates/repopulates a new EntityStore outside timed sections for each repetition; warmed runtime reuses one fixture after two untimed complete passes. Both run in an already-loaded Node process.',
      excluded:
        'No DOM/layout/paint/hydration, browser cold/hot navigation, IndexedDB, real network/model, physical phone, hardware comparison, LCP/INP/CLS or real-user percentile.',
      fixture: {
        synthetic: true,
        messages: 3000,
        cards: 1000,
        memories: 5000,
        ledgerRecords: 50000,
        sha256: fixtureHash,
      },
      order: scenarios.map((scenario) => scenario.name),
    },
    runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    sourceSha256: digest(hashesAfter),
    sourceFiles: hashesAfter,
    sourceStableDuringRun: true,
    existingArtifacts: artifactBytes(),
    results,
    archives: archiveReports,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Saved ${output}\n`);
  process.stdout.write(
    `${JSON.stringify(
      results.map(({ phase, scenario, medianMs, worstMs }) => ({ phase, scenario, medianMs, worstMs })),
      null,
      2,
    )}\n`,
  );
} finally {
  await server?.close();
  if (
    dirname(resolve(cacheDirectory)) !== resolve(tmpdir()) ||
    !cacheDirectory.startsWith(join(tmpdir(), 'dramatis-ui-benchmark-'))
  ) {
    process.stderr.write('Unexpected benchmark cache path; cleanup skipped.\n');
    process.exitCode = 1;
  } else {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
}
