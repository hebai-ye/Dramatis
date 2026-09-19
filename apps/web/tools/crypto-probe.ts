import {
  CryptoError,
  createSpaceCredentials,
  decryptRecord,
  deriveSpaceHandle,
  encryptRecord,
  newRecoveryCode,
  normalizeRecoveryCode,
  openSpace,
  recordAad,
  recordSize,
  SPACE_HANDLE_ITERATIONS,
  SYNC_KEY_ITERATIONS,
  verifyCredential,
} from '@dramatis/core';

/**
 * 同步加密探针（P2-6 第二步，开发用页面，不进应用构建）。
 *
 * 打开 `http://127.0.0.1:5273/tools/crypto-probe.html` 就会用**真实浏览器**的
 * WebCrypto 跑一遍加密工具的自测：
 *
 * 1. `crypto.subtle` 在不在（不在就说明不是安全上下文，同步功能根本没法用）；
 * 2. 真参数（100k 折 id、600k 派生钥匙）各要多少毫秒——这是「建空间/登录
 *    要等多久」的唯一实测依据；
 * 3. 密码与恢复码**解出来的是同一把主密钥**（「等价凭证」这句话真的成立）；
 * 4. 记录的 AAD 把密文钉死在坐标上：挪个位置就解不开。
 *
 * 单测跑在 Node 上，证不了浏览器里的行为（尤其 `crypto.subtle` 的安全上下文
 * 要求与 PBKDF2 的真实耗时），所以这一步用真浏览器复核一次。
 */

const lines: string[] = [];
const out = document.querySelector('#out');

function say(text: string): void {
  lines.push(text);
  if (out) out.textContent = lines.join('\n');
}

async function timeIt<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await run();
  say(`✅ ${label}：${(performance.now() - started).toFixed(0)} ms`);
  return value;
}

async function check(label: string, run: () => Promise<boolean> | boolean): Promise<void> {
  try {
    const ok = await run();
    say(`${ok ? '✅' : '❌'} ${label}`);
  } catch (error) {
    const message = error instanceof CryptoError ? error.message : String(error);
    say(`❌ ${label} —— ${message}`);
  }
}

async function main(): Promise<void> {
  say(`WebCrypto：${globalThis.crypto?.subtle === undefined ? '缺失（不是安全上下文）' : '在'}`);
  say(`参数：折 id ${String(SPACE_HANDLE_ITERATIONS)} 次 / 派生钥匙 ${String(SYNC_KEY_ITERATIONS)} 次 PBKDF2-SHA256`);
  say('');

  const userId = '旅人-probe';
  const password = '一句够长的同步密码';

  await timeIt('deriveSpaceHandle（用户 id → 空间句柄）', () => deriveSpaceHandle(userId));

  const created = await timeIt('createSpaceCredentials（建空间：2 次派生 + 2 份钥匙封装 + 2 个凭证）', () =>
    createSpaceCredentials({ userId, password }),
  );
  say(`   恢复码：${created.recoveryCode}`);
  say('');

  await check('空间句柄是 base64url', () => /^[A-Za-z0-9_-]+$/.test(created.spaceHandle));
  await check('密码凭证是 HMAC-SHA256（43 个 base64url 字符）', () => created.credential.length === 43);
  await check('服务端那份哈希认这个凭证', () => verifyCredential(created.credential, created.credentialHash));
  await check(
    '错一个字符就不认',
    async () => !(await verifyCredential(`${created.credential}x`, created.credentialHash)),
  );
  await check('恢复码凭证服务端也认', () =>
    verifyCredential(created.recoveryCredential, created.recoveryCredentialHash),
  );

  const coordinates = { spaceHandle: created.spaceHandle, collection: 'messages', id: 'probe-msg-1', rev: 3 };
  const payload = { id: 'probe-msg-1', content: '「三十箱货是谁的？」', audience: ['inst-1'] };
  const sealed = await timeIt('encryptRecord（加密一条记录）', () =>
    encryptRecord(created.encKey, coordinates, payload),
  );
  say(`   记录 ${String(recordSize(sealed))} 字节（IV + 密文，不含 base64 膨胀）`);
  await check('密文里看不出明文', () => !JSON.stringify(sealed).includes('三十箱'));
  await check('原坐标能解开、内容一致', async () => {
    const back = await decryptRecord<typeof payload>(created.encKey, coordinates, sealed);
    return JSON.stringify(back) === JSON.stringify(payload);
  });
  await check('被挪到别的集合 → 解不开（AAD 绑死坐标）', async () => {
    try {
      await decryptRecord(created.encKey, { ...coordinates, collection: 'memories' }, sealed);
      return false;
    } catch (error) {
      return error instanceof CryptoError;
    }
  });
  await check('rev 被改（旧密文顶新版本）→ 解不开', async () => {
    try {
      await decryptRecord(created.encKey, { ...coordinates, rev: 4 }, sealed);
      return false;
    } catch (error) {
      return error instanceof CryptoError;
    }
  });
  await check('AAD 形状就是「空间|集合|id|rev」', () => {
    const aad = new TextDecoder().decode(recordAad(coordinates));
    return aad === `${created.spaceHandle}|messages|probe-msg-1|3`;
  });

  say('');
  const byPassword = await timeIt('openSpace（用密码登录：派生 + 解主密钥 + 算凭证）', () =>
    openSpace({
      spaceHandle: created.spaceHandle,
      secret: password,
      purpose: 'password',
      wrapped: created.passwordWrap,
    }),
  );
  await check('密码登录算出的凭证与建空间时一致', () => byPassword.credential === created.credential);
  await check(
    '密码解出来的主密钥能开这段密文',
    async () => JSON.stringify(await decryptRecord(byPassword.encKey, coordinates, sealed)) === JSON.stringify(payload),
  );

  const sloppyRecovery = created.recoveryCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
  const byRecovery = await timeIt('openSpace（用抄得潦草的恢复码登录）', () =>
    openSpace({
      spaceHandle: created.spaceHandle,
      secret: sloppyRecovery,
      purpose: 'recovery',
      wrapped: created.recoveryWrap,
    }),
  );
  say(
    `   归一后的恢复码与原件一致：${String(normalizeRecoveryCode(sloppyRecovery) === created.recoveryCode.replace(/-/g, ''))}`,
  );
  await check(
    '恢复码解出来的也是同一把主密钥（等价凭证成立）',
    async () => JSON.stringify(await decryptRecord(byRecovery.encKey, coordinates, sealed)) === JSON.stringify(payload),
  );
  await check('恢复码不能拿去解密码那一份封装（用途绑死）', async () => {
    try {
      await openSpace({
        spaceHandle: created.spaceHandle,
        secret: created.recoveryCode,
        purpose: 'recovery',
        wrapped: created.passwordWrap,
      });
      return false;
    } catch (error) {
      return error instanceof CryptoError;
    }
  });
  await check('密码错时明确报「解不开主密钥」', async () => {
    try {
      await openSpace({
        spaceHandle: created.spaceHandle,
        secret: '另一个密码',
        purpose: 'password',
        wrapped: created.passwordWrap,
      });
      return false;
    } catch (error) {
      return error instanceof CryptoError && error.message.includes('解不开主密钥');
    }
  });

  say('');
  await check('恢复码是 52 个 base32 字符、四位一组', () => {
    const code = newRecoveryCode();
    return code.replace(/-/g, '').length === 52 && /^[0-9A-Z]{4}(-[0-9A-Z]{4})*$/.test(code);
  });
  say('全部检查结束。');
}

void main().catch((error: unknown) => {
  say(`探针跑挂了：${error instanceof Error ? error.message : String(error)}`);
});
