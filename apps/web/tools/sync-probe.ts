import {
  createBlankCard,
  createMemoryEntityStore,
  createMemorySyncTransport,
  createPersona,
  createPlayerMessage,
  createSpaceCredentials,
  createTurnId,
  createWorldFromCard,
  openSpace,
  Repository,
  type RoomId,
  runSync,
  type SceneId,
} from '@dramatis/core';

/**
 * 同步探针（P2-6 第三步，开发用页面，不进应用构建）。
 *
 * 打开 `http://127.0.0.1:5273/tools/sync-probe.html` 就会在**真浏览器**里
 * 演一遍「两台设备同一条世界线」：
 *
 * 1. A 建空间（真 600k 迭代）并写一条世界线，推上去；
 * 2. B 拿用户 id + 同步密码加入（不经过 A 的本地库），第一次同步就拿到同一条线；
 * 3. 两边各自离线聊两轮，联网合并——两边的消息条数与顺序必须一致；
 * 4. A 删掉一条，B 同步后也看不到它（墓碑传过去了）；
 * 5. 顺手证明服务端手里只有密文。
 *
 * 内存服务端（`createMemorySyncTransport`）与 Cloudflare Worker 要实现的
 * 是同一份接口契约，所以这一步验的就是真实链路，只是后端换成了内存。
 */

const lines: string[] = [];
const out = document.querySelector('#out');

function say(text: string): void {
  lines.push(text);
  if (out) out.textContent = lines.join('\n');
}

function check(label: string, ok: boolean): void {
  say(`${ok ? '✅' : '❌'} ${label}`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function seedWorld(repository: Repository, title: string) {
  const persona = createPersona({ name: '旅人' });
  await repository.savePersona(persona);
  const card = createBlankCard({ name: '陈九' });
  const world = createWorldFromCard(card, persona);
  await repository.saveCard(card);
  await repository.saveSnapshot({
    room: world.room,
    conversations: [world.conversation],
    scenes: [world.scene],
    instances: [world.instance],
  });
  await repository.saveRoom({ ...world.room, title });
  await repository.saveConversation(world.conversation);
  return world;
}

async function say_(repository: Repository, roomId: RoomId, sceneId: SceneId, content: string): Promise<string> {
  const [saved] = await repository.appendMessages(roomId, [
    createPlayerMessage({ roomId, sceneId, turnId: createTurnId(), speakerName: '旅人', content }),
  ]);
  if (!saved) throw new Error('未写入');
  return saved.id;
}

async function main(): Promise<void> {
  const started = performance.now();

  // 1) A 建空间
  const created = await createSpaceCredentials({ userId: '旅人-probe', password: '一句够长的同步密码' });
  const server = createMemorySyncTransport({
    spaceHandle: created.spaceHandle,
    credentialHash: created.credentialHash,
  });
  const a = new Repository(createMemoryEntityStore());
  const world = await seedWorld(a, '老世界');
  await say_(a, world.room.id, world.scene.id, '三十箱货是谁的？');

  const pushedA = await runSync({
    repository: a,
    transport: server.transport,
    spaceHandle: created.spaceHandle,
    credential: created.credential,
    encKey: created.encKey,
  });
  say(
    `A 推上去 ${String(pushedA.pushed)} 条记录（建空间 + 世界线 + 一条消息），服务端现在到第 ${String(server.stats().head)} 号`,
  );

  // 2) B 用密码加入
  const joined = await openSpace({
    spaceHandle: created.spaceHandle,
    secret: '一句够长的同步密码',
    purpose: 'password',
    wrapped: created.passwordWrap,
  });
  const b = new Repository(createMemoryEntityStore());

  const pullB = await runSync({
    repository: b,
    transport: server.transport,
    spaceHandle: created.spaceHandle,
    credential: joined.credential,
    encKey: joined.encKey,
  });
  const loaded = await b.loadRoom(world.room.id);
  say('');
  say(`B 第一次同步：拉回 ${String(pullB.pulled)} 条、写进库 ${String(pullB.applied)} 条`);
  check('B 看到同一条世界线（标题一致）', loaded?.room.title === '老世界');
  check('B 看到同一个场景与角色', loaded?.scenes.length === 1 && loaded?.instances.length === 1);
  check(
    'B 看到那条消息，内容一字不差',
    loaded?.messages.map((message) => message.content).join('|') === '三十箱货是谁的？',
  );
  check('B 的消息带着**原设备**的设备号', (await b.deviceId()) !== loaded?.messages[0]?.deviceId);

  // 3) 两边离线各聊两轮
  await say_(a, world.room.id, world.scene.id, 'A 在船上写的');
  await delay(3);
  await say_(a, world.room.id, world.scene.id, 'A 又补了一句');
  await delay(3);
  await say_(b, world.room.id, world.scene.id, 'B 在手机上写的');
  await delay(3);
  await say_(b, world.room.id, world.scene.id, 'B 也补了一句');

  for (const [device, credential, encKey] of [
    [a, created.credential, created.encKey],
    [b, joined.credential, joined.encKey],
    [a, created.credential, created.encKey],
  ] as const) {
    await runSync({
      repository: device,
      transport: server.transport,
      spaceHandle: created.spaceHandle,
      credential,
      encKey,
    });
  }

  const onA = (await a.listMessages(world.room.id)).map((message) => message.content);
  const onB = (await b.listMessages(world.room.id)).map((message) => message.content);
  say('');
  say(`合并后 A：${onA.join(' / ')}`);
  say(`合并后 B：${onB.join(' / ')}`);
  // 世界线里本来就有 1 条消息，两边各写 2 条 → 合并后 5 条
  check('两边的条数与顺序完全一致', onA.join('|') === onB.join('|') && onA.length === 5);
  check('两台设备的消息按时间交错（不是设备分组）', onA[2] === 'A 又补了一句' && onA[3] === 'B 在手机上写的');

  // 4) 删一条，墓碑传过去
  const doomed = onA[0] === undefined ? '' : '三十箱货是谁的？';
  const target = (await a.listMessages(world.room.id)).find((message) => message.content === doomed);
  if (target) {
    await a.deleteMessage(target.id);
    await runSync({
      repository: a,
      transport: server.transport,
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      encKey: created.encKey,
    });
    await runSync({
      repository: b,
      transport: server.transport,
      spaceHandle: created.spaceHandle,
      credential: joined.credential,
      encKey: joined.encKey,
    });
    const onBAfter = await b.listMessages(world.room.id);
    const tombstone = await b.getSyncRecord('messages', target.id);
    say('');
    check('A 删掉的那条，B 同步后也看不到了', !onBAfter.some((message) => message.id === target.id));
    check('B 的库里留的是墓碑（不是「没同步到」）', tombstone?.deletedAt !== null);
  }

  // 5) 服务端只有密文
  const rawServer = JSON.stringify(server.raw());
  say('');
  check(
    '服务端手里没有任何明文（消息内容、世界标题都没有）',
    !rawServer.includes('三十箱') && !rawServer.includes('老世界'),
  );
  check('服务端存的是密文与坐标（集合名可见）', rawServer.includes('messages') && rawServer.includes('ciphertext'));
  say(`服务端：${String(server.stats().records)} 条记录、头号 ${String(server.stats().head)}`);

  // 6) 幂等：再跑一轮，不该有任何变化
  const idle = await runSync({
    repository: b,
    transport: server.transport,
    spaceHandle: created.spaceHandle,
    credential: joined.credential,
    encKey: joined.encKey,
  });
  check('再跑一轮同步是空转（幂等）', idle.pushed === 0 && idle.applied === 0);

  say('');
  say(`全部检查结束，用时 ${(performance.now() - started).toFixed(0)} ms。`);
}

void main().catch((error: unknown) => {
  say(`探针跑挂了：${error instanceof Error ? error.message : String(error)}`);
});
