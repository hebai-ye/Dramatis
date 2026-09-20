import {
  createBlankCard,
  createMemoryEntityStore,
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
import { createHttpSyncTransport, createRemoteSpace, fetchRemoteSpace } from '../src/lib/sync-transport';

/**
 * 同步探针 · 走 HTTP（P2-6 第四步，开发用页面，不进应用构建）。
 *
 * 与 `sync-probe.html` 的区别：那个用内存服务端，这个**真的发 HTTP 请求**，
 * 打到 vite 上的开发后端（`/sync/*`，数据存 JSON 文件）。它验的是这一步
 * 新加的那层：HTTP 外壳、fetch 传输层、建空间 / 取空间元数据两个新接口。
 *
 * 打开 `http://127.0.0.1:5275/tools/sync-http-probe.html` 就会跑：
 *
 * 1. A 建空间（真 600k 迭代）→ **POST /spaces** 登记 → 写一条世界线 → 推上去；
 * 2. B 只拿用户 id + 密码：**GET /spaces/{handle}** 取钥匙封装 → 解开主密钥
 *    → 第一次同步就拿到同一条世界线；
 * 3. 两边各自离线聊两轮 → 合并后逐字一致；
 * 4. A 删一条 → B 同步后也看不到；
 * 5. 直接看服务端返回的原始 JSON：里面只有密文。
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

async function append(repository: Repository, roomId: RoomId, sceneId: SceneId, content: string): Promise<string> {
  const [saved] = await repository.appendMessages(roomId, [
    createPlayerMessage({ roomId, sceneId, turnId: createTurnId(), speakerName: '旅人', content }),
  ]);
  if (!saved) throw new Error('未写入');
  return saved.id;
}

async function main(): Promise<void> {
  const started = performance.now();
  const endpoint = `${location.origin}/sync`;
  say(`服务端：${endpoint}`);

  // 每次跑用一个新 id：开发后端是持久化的，重复用同一个 id 会撞上「已存在」
  const userId = `旅人-http-${String(Date.now())}`;
  const password = '一句够长的同步密码';

  const created = await createSpaceCredentials({ userId, password });
  const registered = await createRemoteSpace(
    { endpoint },
    {
      spaceHandle: created.spaceHandle,
      credentialHash: created.credentialHash,
      recoveryCredentialHash: created.recoveryCredentialHash,
      keyWraps: { password: created.passwordWrap, recovery: created.recoveryWrap },
    },
  );
  say(`POST /spaces → ${registered}（空间句柄 ${created.spaceHandle.slice(0, 12)}…）`);

  const transport = createHttpSyncTransport({ endpoint });
  const a = new Repository(createMemoryEntityStore());
  const world = await seedWorld(a, '老世界');
  await append(a, world.room.id, world.scene.id, '三十箱货是谁的？');

  const pushedA = await runSync({
    repository: a,
    transport,
    spaceHandle: created.spaceHandle,
    credential: created.credential,
    encKey: created.encKey,
  });
  say(`A 推上去 ${String(pushedA.pushed)} 条记录，服务端 head=${String(pushedA.head)}`);

  // B 只拿 id + 密码（没有 A 的本地库）
  const meta = await fetchRemoteSpace({ endpoint }, created.spaceHandle);
  check(
    'GET /spaces/{handle} 拿得到钥匙封装（两份，公开但有密文保护）',
    meta !== null && Object.keys(meta.keyWraps).length === 2,
  );
  if (meta === null) return;

  const joined = await openSpace({
    spaceHandle: created.spaceHandle,
    secret: password,
    purpose: 'password',
    wrapped: meta.keyWraps.password as never,
  });
  check('B 用密码解出的凭证与 A 的一致（同一空间同一身份）', joined.credential === created.credential);

  const b = new Repository(createMemoryEntityStore());
  const pulledB = await runSync({
    repository: b,
    transport,
    spaceHandle: created.spaceHandle,
    credential: joined.credential,
    encKey: joined.encKey,
  });
  const loaded = await b.loadRoom(world.room.id);
  say('');
  say(`B 第一次同步：拉回 ${String(pulledB.pulled)} 条、写进库 ${String(pulledB.applied)} 条`);
  check('B 看到同一条世界线', loaded?.room.title === '老世界');
  check(
    'B 看到那条消息，内容一字不差',
    loaded?.messages.map((message) => message.content).join('|') === '三十箱货是谁的？',
  );

  // 两边离线各聊两轮
  await append(a, world.room.id, world.scene.id, 'A 在船上写的');
  await delay(3);
  await append(a, world.room.id, world.scene.id, 'A 又补了一句');
  await delay(3);
  await append(b, world.room.id, world.scene.id, 'B 在手机上写的');
  await delay(3);
  await append(b, world.room.id, world.scene.id, 'B 也补了一句');

  for (const [repository, credential, encKey] of [
    [a, created.credential, created.encKey],
    [b, joined.credential, joined.encKey],
    [a, created.credential, created.encKey],
  ] as const) {
    await runSync({ repository, transport, spaceHandle: created.spaceHandle, credential, encKey });
  }

  const onA = (await a.listMessages(world.room.id)).map((message) => message.content);
  const onB = (await b.listMessages(world.room.id)).map((message) => message.content);
  say('');
  say(`合并后 A：${onA.join(' / ')}`);
  say(`合并后 B：${onB.join(' / ')}`);
  check('两边条数与顺序完全一致', onA.join('|') === onB.join('|') && onA.length === 5);
  check('两台设备的消息按时间交错', onA[2] === 'A 又补了一句' && onA[3] === 'B 在手机上写的');

  // 删一条，墓碑传过去
  const target = (await a.listMessages(world.room.id)).find((message) => message.content === '三十箱货是谁的？');
  if (target) {
    await a.deleteMessage(target.id);
    await runSync({
      repository: a,
      transport,
      spaceHandle: created.spaceHandle,
      credential: created.credential,
      encKey: created.encKey,
    });
    await runSync({
      repository: b,
      transport,
      spaceHandle: created.spaceHandle,
      credential: joined.credential,
      encKey: joined.encKey,
    });
    const onBAfter = await b.listMessages(world.room.id);
    const tombstone = await b.getSyncRecord('messages', target.id);
    say('');
    check('A 删掉的那条，B 同步后也看不到', !onBAfter.some((message) => message.id === target.id));
    check('B 的库里留的是墓碑', tombstone?.deletedAt !== null);
  }

  // 服务端返回的原始 JSON 里有没有明文
  const rawPull = await fetch(`${endpoint}/spaces/${created.spaceHandle}/pull?since=0`, {
    headers: { authorization: `Bearer ${joined.credential}` },
  });
  const rawText = await rawPull.text();
  say('');
  check(
    '服务端返回的原始数据里没有明文（消息内容、世界标题）',
    !rawText.includes('三十箱') && !rawText.includes('老世界'),
  );
  check('里面有密文与坐标', rawText.includes('ciphertext') && rawText.includes('serverRev'));

  const idle = await runSync({
    repository: b,
    transport,
    spaceHandle: created.spaceHandle,
    credential: joined.credential,
    encKey: joined.encKey,
  });
  check('再跑一轮是空转（幂等）', idle.pushed === 0 && idle.applied === 0);

  say('');
  say(`全部检查结束，用时 ${(performance.now() - started).toFixed(0)} ms。`);
}

void main().catch((error: unknown) => {
  say(`探针跑挂了：${error instanceof Error ? error.message : String(error)}`);
});
