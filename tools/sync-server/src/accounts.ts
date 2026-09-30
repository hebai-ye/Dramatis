import {
  createRateWindow,
  deriveSpaceHandle,
  normalizeUserId,
  type SqliteDatabase,
  verifyCredential,
} from '../../../packages/core/src/index.js';

interface SpaceProof {
  credential_hash: string;
  recovery_credential_hash: string;
  epoch: string;
}

interface ProfileRow {
  space_handle: string;
  account_id: string;
  display_name: string;
  claimed_at: string;
  space_epoch: string;
}

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function fail(status: number, code: string): Response {
  return reply(status, { error: { code } });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 运营资料拒绝控制字符
const CONTROLS = /[\u0000-\u001f\u007f]/;
const plain = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROLS.test(value);

/** 用户自助认领；独立于管理员接口，不给调用者枚举其他账户的能力。 */
export function createAccountProfileHandler(db: SqliteDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_profiles (
    space_handle TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    space_epoch TEXT NOT NULL
  )`);
  const attempts = createRateWindow({ limit: 10, now: () => Date.now() });

  return async (
    request: Request,
    context: { clientKey: string; allowedOrigins?: readonly string[] },
  ): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin !== null) {
      let sameHost = false;
      try {
        const parsed = new URL(origin);
        sameHost = parsed.host === url.host && ['http:', 'https:'].includes(parsed.protocol);
      } catch {
        return fail(403, 'origin-denied');
      }
      // TLS 入口可能改写 Host 或去掉端口。Fetch Metadata 仅判别浏览器请求来源，
      // 不充当身份：下方仍要求 Bearer、账户句柄匹配以及事务内重验所有权。
      const sameOriginBrowser = request.headers.get('sec-fetch-site') === 'same-origin';
      if (!sameHost && !sameOriginBrowser && !context.allowedOrigins?.includes(origin))
        return fail(403, 'origin-denied');
      if (request.headers.get('sec-fetch-site') === 'cross-site' && !context.allowedOrigins?.includes(origin))
        return fail(403, 'origin-denied');
    }
    if (request.method === 'OPTIONS') {
      if (origin === null || !context.allowedOrigins?.includes(origin)) return fail(403, 'origin-denied');
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'authorization, content-type',
          vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return fail(405, 'method-not-allowed');
    if (!attempts.hit(context.clientKey)) return fail(429, 'rate-limited');
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return fail(415, 'json-required');
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4096) return fail(413, 'payload-too-large');
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'bad-request');
      body = value as Record<string, unknown>;
    } catch {
      return fail(400, 'bad-request');
    }
    const allowed = ['spaceHandle', 'accountId', 'displayName', 'confirmed'];
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      body.confirmed !== true ||
      !plain(body.accountId, 128) ||
      !plain(body.displayName, 80) ||
      typeof body.spaceHandle !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.spaceHandle)
    )
      return fail(400, 'bad-request');

    const proof = /^Bearer ([A-Za-z0-9_-]{1,128})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (proof === undefined) return fail(401, 'unauthorized');
    const selectProof = db.prepare(
      'SELECT credential_hash, recovery_credential_hash, epoch FROM spaces WHERE space_handle = ?',
    );
    const space = selectProof.get(body.spaceHandle) as SpaceProof | undefined;
    if (
      space === undefined ||
      (!(await verifyCredential(proof, space.credential_hash)) &&
        !(await verifyCredential(proof, space.recovery_credential_hash)))
    )
      return fail(401, 'unauthorized');
    const accountId = normalizeUserId(body.accountId);
    if ((await deriveSpaceHandle(accountId)) !== body.spaceHandle) return fail(409, 'account-space-mismatch');
    if (!space.epoch) return fail(503, 'space-epoch-unavailable');

    db.exec('BEGIN IMMEDIATE');
    let profile: ProfileRow;
    let created = false;
    try {
      const current = selectProof.get(body.spaceHandle) as SpaceProof | undefined;
      if (
        current?.epoch !== space.epoch ||
        current.credential_hash !== space.credential_hash ||
        current.recovery_credential_hash !== space.recovery_credential_hash
      ) {
        db.exec('ROLLBACK');
        return fail(409, 'space-changed');
      }
      const before = db
        .prepare('SELECT space_epoch FROM account_profiles WHERE space_handle = ?')
        .get(body.spaceHandle) as { space_epoch: string } | undefined;
      created = before === undefined || before.space_epoch !== space.epoch;
      db.prepare(`INSERT INTO account_profiles (space_handle, account_id, display_name, claimed_at, space_epoch)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_handle) DO UPDATE SET
          account_id = excluded.account_id, display_name = excluded.display_name,
          claimed_at = excluded.claimed_at, space_epoch = excluded.space_epoch
        WHERE account_profiles.space_epoch != excluded.space_epoch`).run(
        body.spaceHandle,
        accountId,
        body.displayName.trim(),
        new Date().toISOString(),
        space.epoch,
      );
      profile = db
        .prepare(`SELECT space_handle, account_id, display_name, claimed_at, space_epoch
        FROM account_profiles WHERE space_handle = ?`)
        .get(body.spaceHandle) as ProfileRow;
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const response = reply(created ? 201 : 200, {
      profile: {
        spaceHandle: profile.space_handle,
        accountId: profile.account_id,
        displayName: profile.display_name,
        claimedAt: profile.claimed_at,
      },
    });
    if (origin !== null && context.allowedOrigins?.includes(origin)) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.set('vary', 'Origin');
    }
    return response;
  };
}
