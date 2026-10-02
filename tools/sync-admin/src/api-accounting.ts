import { getVipPlan, type VipPlan } from './vip-plans.js';

/** 兼容同步宿主与 node:sqlite 的最小接口，无管理 HTTP 依赖。 */
export interface AccountingDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
    get(...params: readonly unknown[]): unknown;
    run(...params: readonly unknown[]): unknown;
  };
}

const MAX_NANOYUAN = 9_000_000_000_000_000n;
const DAY_MS = 86_400_000;
const MODEL = 'deepseek-flash';
const UNRESOLVED = "state IN ('reserved','sent','pending')";

export class ApiAccountingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiAccountingError';
  }
}

function fail(code: string): never {
  throw new ApiAccountingError(code);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('invalid-request');
  return value;
}

function amount(value: unknown): bigint {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)))
    fail('invalid-amount');
  const result = BigInt(value);
  if (result < 0n || result > MAX_NANOYUAN) fail('invalid-amount');
  return result;
}

function storedAmount(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Number(MAX_NANOYUAN))
    fail('invalid-ledger');
  return BigInt(value);
}

function iso(value: string | number): string {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8_640_000_000_000_000) fail('invalid-request');
  return new Date(parsed).toISOString();
}

function columns(db: AccountingDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  space_memberships: [
    'space_handle',
    'space_epoch',
    'started_at',
    'expires_at',
    'revoked_at',
    'plan_id',
    'plan_version',
  ],
  membership_purchases: [
    'operation_id',
    'space_handle',
    'space_epoch',
    'plan_id',
    'plan_version',
    'plan_name',
    'duration_days',
    'max_bytes',
    'price_fen',
    'api_credit_nanoyuan',
    'event_at',
    'paid_until',
    'revision',
    'membership_event_id',
  ],
  api_balance_events: [
    'event_id',
    'space_handle',
    'space_epoch',
    'event_type',
    'source_operation_id',
    'request_id',
    'amount_nanoyuan',
    'created_at',
  ],
  api_accounts: ['space_handle', 'space_epoch', 'paid_until', 'revision'],
  api_requests: [
    'request_id',
    'space_handle',
    'space_epoch',
    'state',
    'reserved_nanoyuan',
    'charged_nanoyuan',
    'model',
    'price_version',
    'price_period',
    'max_output_tokens',
    'started_at',
    'sent_at',
    'completed_at',
    'upstream_id',
    'prompt_tokens',
    'cache_hit_tokens',
    'cache_miss_tokens',
    'completion_tokens',
    'total_tokens',
    'reasoning_tokens',
    'pending_reason',
  ],
};

export function apiAccountingAvailable(db: AccountingDatabase): boolean {
  return Object.entries(REQUIRED_COLUMNS).every(([table, required]) => {
    const actual = columns(db, table);
    return required.every((name) => actual.includes(name));
  });
}

function requireSchema(db: AccountingDatabase): void {
  if (!apiAccountingAvailable(db)) fail('schema-unavailable');
}

function immediate<T>(db: AccountingDatabase, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 只有同步宿主启动时调用；旧会员身份保持 NULL，不生成历史购买或额度。 */
export function initializeApiAccounting(db: AccountingDatabase): void {
  immediate(db, () => {
    const memberColumns = columns(db, 'space_memberships');
    if (!memberColumns.includes('space_epoch')) fail('schema-unavailable');
    if (!memberColumns.includes('plan_id')) db.exec('ALTER TABLE space_memberships ADD COLUMN plan_id TEXT');
    if (!memberColumns.includes('plan_version')) db.exec('ALTER TABLE space_memberships ADD COLUMN plan_version TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS membership_purchases (
      operation_id TEXT PRIMARY KEY, space_handle TEXT NOT NULL, space_epoch TEXT NOT NULL,
      plan_id TEXT NOT NULL, plan_version TEXT NOT NULL, plan_name TEXT NOT NULL,
      duration_days INTEGER NOT NULL, max_bytes INTEGER NOT NULL, price_fen INTEGER NOT NULL,
      api_credit_nanoyuan INTEGER NOT NULL CHECK(typeof(api_credit_nanoyuan)='integer' AND api_credit_nanoyuan BETWEEN 0 AND 9000000000000000),
      event_at TEXT NOT NULL, paid_until TEXT NOT NULL, revision INTEGER NOT NULL,
      membership_event_id TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS purchases_by_space ON membership_purchases(space_handle,space_epoch,event_at);
    CREATE TABLE IF NOT EXISTS api_balance_events (
      event_id TEXT PRIMARY KEY, space_handle TEXT NOT NULL, space_epoch TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('credit','charge')),
      source_operation_id TEXT, request_id TEXT,
      amount_nanoyuan INTEGER NOT NULL CHECK(typeof(amount_nanoyuan)='integer' AND amount_nanoyuan BETWEEN 0 AND 9000000000000000),
      created_at TEXT NOT NULL,
      CHECK((event_type='credit' AND source_operation_id IS NOT NULL AND request_id IS NULL)
        OR (event_type='charge' AND source_operation_id IS NULL AND request_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS credits_by_operation ON api_balance_events(source_operation_id) WHERE event_type='credit';
    CREATE UNIQUE INDEX IF NOT EXISTS charges_by_request ON api_balance_events(request_id) WHERE event_type='charge';
    CREATE INDEX IF NOT EXISTS balance_by_space ON api_balance_events(space_handle,space_epoch);
    CREATE TABLE IF NOT EXISTS api_accounts (
      space_handle TEXT NOT NULL, space_epoch TEXT NOT NULL, paid_until TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(space_handle,space_epoch)
    );
    CREATE TABLE IF NOT EXISTS api_requests (
      request_id TEXT PRIMARY KEY, space_handle TEXT NOT NULL, space_epoch TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','sent','settled','pending','released')),
      reserved_nanoyuan INTEGER NOT NULL CHECK(typeof(reserved_nanoyuan)='integer' AND reserved_nanoyuan BETWEEN 0 AND 9000000000000000),
      charged_nanoyuan INTEGER CHECK(charged_nanoyuan IS NULL OR (typeof(charged_nanoyuan)='integer' AND charged_nanoyuan BETWEEN 0 AND 9000000000000000)),
      model TEXT NOT NULL, price_version TEXT NOT NULL, price_period TEXT NOT NULL CHECK(price_period IN ('peak','offpeak')),
      max_output_tokens INTEGER NOT NULL, started_at TEXT NOT NULL, sent_at TEXT, completed_at TEXT,
      upstream_id TEXT, prompt_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
      completion_tokens INTEGER, total_tokens INTEGER, reasoning_tokens INTEGER, pending_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unresolved_by_account ON api_requests(space_handle,space_epoch) WHERE ${UNRESOLVED};
    CREATE INDEX IF NOT EXISTS requests_by_space ON api_requests(space_handle,space_epoch,started_at);
    CREATE TRIGGER IF NOT EXISTS balance_events_no_update BEFORE UPDATE ON api_balance_events
      BEGIN SELECT RAISE(ABORT,'append-only accounting events'); END;
    CREATE TRIGGER IF NOT EXISTS balance_events_no_delete BEFORE DELETE ON api_balance_events
      BEGIN SELECT RAISE(ABORT,'append-only accounting events'); END;
    CREATE TRIGGER IF NOT EXISTS purchases_no_update BEFORE UPDATE ON membership_purchases
      BEGIN SELECT RAISE(ABORT,'append-only purchases'); END;
    CREATE TRIGGER IF NOT EXISTS purchases_no_delete BEFORE DELETE ON membership_purchases
      BEGIN SELECT RAISE(ABORT,'append-only purchases'); END;`);
    requireSchema(db);
  });
}

interface PurchaseRow {
  operation_id: string;
  space_handle: string;
  space_epoch: string;
  plan_id: string;
  plan_version: string;
  plan_name: string;
  duration_days: number;
  max_bytes: number;
  price_fen: number;
  api_credit_nanoyuan: number;
  event_at: string;
  paid_until: string;
  revision: number;
}

const PURCHASE_COLUMNS =
  'operation_id,space_handle,space_epoch,plan_id,plan_version,plan_name,duration_days,max_bytes,price_fen,api_credit_nanoyuan,event_at,paid_until,revision';

function presentPurchase(row: PurchaseRow) {
  return {
    operationId: row.operation_id,
    spaceHandle: row.space_handle,
    spaceEpoch: row.space_epoch,
    planId: row.plan_id,
    planVersion: row.plan_version,
    planName: row.plan_name,
    durationDays: row.duration_days,
    maxBytes: row.max_bytes,
    priceFen: row.price_fen,
    creditNanoyuan: storedAmount(row.api_credit_nanoyuan).toString(),
    eventAt: row.event_at,
    paidUntil: row.paid_until,
    revision: row.revision,
  };
}

interface AccountRow {
  paid_until: string;
  revision: number;
}

function readAccount(db: AccountingDatabase, handle: string, epoch: string): AccountRow | undefined {
  return db
    .prepare('SELECT paid_until,revision FROM api_accounts WHERE space_handle=? AND space_epoch=?')
    .get(handle, epoch) as AccountRow | undefined;
}

/** 调用者已有 IMMEDIATE 事务：与会员事件、当前会员行一起提交，不嵌套事务。 */
export function recordPurchase(
  db: AccountingDatabase,
  input: {
    operationId: string;
    spaceHandle: string;
    spaceEpoch: string;
    plan: VipPlan;
    eventAt: string;
  },
) {
  requireSchema(db);
  identifier(input.operationId);
  identifier(input.spaceHandle);
  identifier(input.spaceEpoch);
  const canonical = getVipPlan(input.plan.id);
  if (Object.keys(canonical).some((key) => input.plan[key as keyof VipPlan] !== canonical[key as keyof VipPlan]))
    fail('invalid-plan');
  const credit = amount(canonical.creditNanoyuan);
  const eventAt = iso(input.eventAt);
  const current = db.prepare('SELECT epoch FROM spaces WHERE space_handle=?').get(input.spaceHandle) as
    | { epoch: string }
    | undefined;
  if (current?.epoch !== input.spaceEpoch) fail('space-changed');
  const previous = db
    .prepare(`SELECT ${PURCHASE_COLUMNS} FROM membership_purchases WHERE operation_id=?`)
    .get(input.operationId) as PurchaseRow | undefined;
  if (previous) {
    if (
      previous.space_handle !== input.spaceHandle ||
      previous.space_epoch !== input.spaceEpoch ||
      previous.plan_id !== canonical.id ||
      previous.plan_version !== canonical.version ||
      previous.event_at !== eventAt ||
      previous.plan_name !== canonical.name ||
      previous.duration_days !== canonical.durationDays ||
      previous.max_bytes !== canonical.maxBytes ||
      previous.price_fen !== canonical.priceFen ||
      storedAmount(previous.api_credit_nanoyuan) !== credit
    )
      fail('purchase-conflict');
    return { ...presentPurchase(previous), created: false };
  }
  const account = readAccount(db, input.spaceHandle, input.spaceEpoch);
  const priorUntil = account ? Date.parse(account.paid_until) : 0;
  if (!Number.isFinite(priorUntil)) fail('invalid-ledger');
  const paidUntil = iso(Math.max(Date.parse(eventAt), priorUntil) + canonical.durationDays * DAY_MS);
  const revision = (account?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) fail('invalid-ledger');
  db.prepare(`INSERT INTO membership_purchases (${PURCHASE_COLUMNS},membership_event_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.operationId,
    input.spaceHandle,
    input.spaceEpoch,
    canonical.id,
    canonical.version,
    canonical.name,
    canonical.durationDays,
    canonical.maxBytes,
    canonical.priceFen,
    Number(credit),
    eventAt,
    paidUntil,
    revision,
    input.operationId,
  );
  db.prepare(`INSERT INTO api_balance_events(event_id,space_handle,space_epoch,event_type,source_operation_id,
    request_id,amount_nanoyuan,created_at) VALUES(?,?,?,'credit',?,NULL,?,?)`).run(
    `purchase:${input.operationId}`,
    input.spaceHandle,
    input.spaceEpoch,
    input.operationId,
    Number(credit),
    eventAt,
  );
  db.prepare(`INSERT INTO api_accounts(space_handle,space_epoch,paid_until,revision) VALUES(?,?,?,?)
    ON CONFLICT(space_handle,space_epoch) DO UPDATE SET paid_until=excluded.paid_until,revision=excluded.revision`).run(
    input.spaceHandle,
    input.spaceEpoch,
    paidUntil,
    revision,
  );
  return {
    ...presentPurchase(
      db
        .prepare(`SELECT ${PURCHASE_COLUMNS} FROM membership_purchases WHERE operation_id=?`)
        .get(input.operationId) as PurchaseRow,
    ),
    created: true,
  };
}

export interface ApiUsage {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

type RequestState = 'reserved' | 'sent' | 'settled' | 'pending' | 'released';
type PricePeriod = 'peak' | 'offpeak';

interface RequestRow {
  request_id: string;
  space_handle: string;
  space_epoch: string;
  state: RequestState;
  reserved_nanoyuan: number;
  charged_nanoyuan: number | null;
  model: string;
  price_version: string;
  price_period: PricePeriod;
  max_output_tokens: number;
  started_at: string;
  sent_at: string | null;
  completed_at: string | null;
  upstream_id: string | null;
  prompt_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  reasoning_tokens: number | null;
  pending_reason: string | null;
}

const REQUEST_COLUMNS =
  'request_id,space_handle,space_epoch,state,reserved_nanoyuan,charged_nanoyuan,model,price_version,price_period,max_output_tokens,started_at,sent_at,completed_at,upstream_id,prompt_tokens,cache_hit_tokens,cache_miss_tokens,completion_tokens,total_tokens,reasoning_tokens,pending_reason';

function presentRequest(row: RequestRow) {
  const usage: ApiUsage | null =
    row.prompt_tokens === null
      ? null
      : {
          promptTokens: row.prompt_tokens,
          cacheHitTokens: row.cache_hit_tokens as number,
          cacheMissTokens: row.cache_miss_tokens as number,
          completionTokens: row.completion_tokens as number,
          totalTokens: row.total_tokens as number,
          ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
        };
  return {
    requestId: row.request_id,
    spaceHandle: row.space_handle,
    spaceEpoch: row.space_epoch,
    state: row.state,
    reservedNanoyuan: storedAmount(row.reserved_nanoyuan).toString(),
    chargedNanoyuan: row.charged_nanoyuan === null ? null : storedAmount(row.charged_nanoyuan).toString(),
    model: row.model,
    priceVersion: row.price_version,
    pricePeriod: row.price_period,
    maxOutputTokens: row.max_output_tokens,
    startedAt: row.started_at,
    sentAt: row.sent_at,
    completedAt: row.completed_at,
    upstreamId: row.upstream_id,
    usage,
    pendingReason: row.pending_reason,
  };
}

function readRequest(db: AccountingDatabase, requestId: string): RequestRow {
  const row = db.prepare(`SELECT ${REQUEST_COLUMNS} FROM api_requests WHERE request_id=?`).get(identifier(requestId)) as
    | RequestRow
    | undefined;
  if (!row) fail('request-not-found');
  return row;
}

function balances(db: AccountingDatabase, handle: string, epoch: string) {
  let granted = 0n;
  let spent = 0n;
  let reserved = 0n;
  const events = db
    .prepare('SELECT event_type,amount_nanoyuan FROM api_balance_events WHERE space_handle=? AND space_epoch=?')
    .all(handle, epoch) as { event_type: string; amount_nanoyuan: number }[];
  for (const event of events) {
    const value = storedAmount(event.amount_nanoyuan);
    if (event.event_type === 'credit') granted += value;
    else if (event.event_type === 'charge') spent += value;
    else fail('invalid-ledger');
  }
  const requests = db
    .prepare(`SELECT reserved_nanoyuan FROM api_requests WHERE space_handle=? AND space_epoch=? AND ${UNRESOLVED}`)
    .all(handle, epoch) as { reserved_nanoyuan: number }[];
  for (const request of requests) reserved += storedAmount(request.reserved_nanoyuan);
  return { granted, spent, reserved, balance: granted - spent, available: granted - spent - reserved };
}

function eligibility(db: AccountingDatabase, handle: string, epoch: string, time: number) {
  const current = db.prepare('SELECT epoch FROM spaces WHERE space_handle=?').get(handle) as
    | { epoch: string }
    | undefined;
  const member = db
    .prepare(`SELECT started_at,expires_at,revoked_at FROM space_memberships
    WHERE space_handle=? AND space_epoch=?`)
    .get(handle, epoch) as
    | {
        started_at: string;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  const account = readAccount(db, handle, epoch);
  const vipActive =
    member !== undefined &&
    member.revoked_at === null &&
    Date.parse(member.started_at) <= time &&
    time < Date.parse(member.expires_at);
  const paidActive = account !== undefined && time < Date.parse(account.paid_until);
  const status =
    current?.epoch !== epoch
      ? 'space-changed'
      : !vipActive
        ? 'vip-inactive'
        : !account
          ? 'no-account'
          : !paidActive
            ? 'paid-expired'
            : 'active';
  return { status, vipActive, paidActive, paidUntil: account?.paid_until ?? null, revision: account?.revision ?? 0 };
}

function pricePeriod(value: unknown): PricePeriod {
  if (value !== 'peak' && value !== 'offpeak') fail('invalid-request');
  return value;
}

function validateUsage(value: ApiUsage, maxOutputTokens: number): ApiUsage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-usage');
  for (const key of ['promptTokens', 'cacheHitTokens', 'cacheMissTokens', 'completionTokens', 'totalTokens'] as const)
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('invalid-usage');
  if (
    value.promptTokens !== value.cacheHitTokens + value.cacheMissTokens ||
    value.totalTokens !== value.promptTokens + value.completionTokens ||
    value.promptTokens > 1_048_576 ||
    value.totalTokens > 1_048_576 ||
    value.completionTokens > maxOutputTokens ||
    (value.reasoningTokens !== undefined &&
      (!Number.isSafeInteger(value.reasoningTokens) ||
        value.reasoningTokens < 0 ||
        value.reasoningTokens > value.completionTokens))
  )
    fail('invalid-usage');
  return {
    promptTokens: value.promptTokens,
    cacheHitTokens: value.cacheHitTokens,
    cacheMissTokens: value.cacheMissTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.totalTokens,
    ...(value.reasoningTokens === undefined ? {} : { reasoningTokens: value.reasoningTokens }),
  };
}

const PENDING_REASONS = new Set([
  'upstream-error',
  'upstream-disconnected',
  'upstream-timeout',
  'missing-usage',
  'invalid-usage',
  'price-boundary',
  'response-too-large',
  'internal-error',
  'restart-unknown',
  'settlement-conflict',
  'over-reservation',
]);

/** 构造和 summary 都不迁移、不恢复；管理端可安全用于只读连接。 */
export function createApiLedger(db: AccountingDatabase, now: () => number = Date.now) {
  return {
    summary(handle: string, epoch: string) {
      if (!apiAccountingAvailable(db))
        return {
          available: false,
          balanceNanoyuan: '0',
          reservedNanoyuan: '0',
          availableNanoyuan: '0',
          grantedNanoyuan: '0',
          spentNanoyuan: '0',
          paidUntil: null,
          paidActive: false,
          vipActive: false,
          status: 'schema-unavailable',
          revision: 0,
          purchases: [],
          requests: [],
        };
      identifier(handle);
      identifier(epoch);
      const balance = balances(db, handle, epoch);
      const eligible = eligibility(db, handle, epoch, now());
      const requests = (
        db
          .prepare(`SELECT ${REQUEST_COLUMNS} FROM api_requests WHERE space_handle=? AND space_epoch=?
        ORDER BY started_at DESC,rowid DESC LIMIT 50`)
          .all(handle, epoch) as RequestRow[]
      ).map(presentRequest);
      const purchases = (
        db
          .prepare(`SELECT ${PURCHASE_COLUMNS} FROM membership_purchases WHERE space_handle=? AND space_epoch=?
        ORDER BY event_at DESC,rowid DESC LIMIT 50`)
          .all(handle, epoch) as PurchaseRow[]
      ).map(presentPurchase);
      const status =
        eligible.status !== 'active'
          ? eligible.status
          : requests.some((request) => request.state === 'pending')
            ? 'pending-review'
            : balance.available <= 0n
              ? 'insufficient-balance'
              : 'active';
      return {
        available: true,
        balanceNanoyuan: balance.balance.toString(),
        reservedNanoyuan: balance.reserved.toString(),
        availableNanoyuan: balance.available.toString(),
        grantedNanoyuan: balance.granted.toString(),
        spentNanoyuan: balance.spent.toString(),
        ...eligible,
        status,
        purchases,
        requests,
      };
    },

    reserve(input: {
      requestId: string;
      spaceHandle: string;
      spaceEpoch: string;
      reservedNanoyuan: string | bigint;
      priceVersion: string;
      pricePeriod: PricePeriod;
      maxOutputTokens: number;
      model?: string;
      startedAt?: string;
      proof?: { credentialHash: string; recoveryCredentialHash: string };
    }) {
      identifier(input.requestId);
      identifier(input.spaceHandle);
      identifier(input.spaceEpoch);
      identifier(input.priceVersion);
      const reserved = amount(input.reservedNanoyuan);
      if (
        reserved <= 0n ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 1 ||
        input.maxOutputTokens > 16_384
      )
        fail('invalid-request');
      const period = pricePeriod(input.pricePeriod);
      const model = input.model ?? MODEL;
      if (model !== MODEL) fail('invalid-request');
      const startedAt = iso(input.startedAt ?? now());
      return immediate(db, () => {
        requireSchema(db);
        const current = db
          .prepare('SELECT epoch,credential_hash,recovery_credential_hash FROM spaces WHERE space_handle=?')
          .get(input.spaceHandle) as
          | { epoch: string; credential_hash: string; recovery_credential_hash: string }
          | undefined;
        if (current?.epoch !== input.spaceEpoch) fail('space-changed');
        if (
          input.proof &&
          (current.credential_hash !== input.proof.credentialHash ||
            current.recovery_credential_hash !== input.proof.recoveryCredentialHash)
        )
          fail('proof-changed');
        const previous = db
          .prepare(`SELECT ${REQUEST_COLUMNS} FROM api_requests WHERE request_id=?`)
          .get(input.requestId) as RequestRow | undefined;
        if (previous) {
          if (
            previous.space_handle !== input.spaceHandle ||
            previous.space_epoch !== input.spaceEpoch ||
            storedAmount(previous.reserved_nanoyuan) !== reserved ||
            previous.price_version !== input.priceVersion ||
            previous.price_period !== period ||
            previous.max_output_tokens !== input.maxOutputTokens ||
            previous.model !== model
          )
            fail('request-conflict');
          return { isNew: false, request: presentRequest(previous), state: previous.state };
        }
        const eligible = eligibility(db, input.spaceHandle, input.spaceEpoch, now());
        if (eligible.status !== 'active') fail(eligible.status);
        if (
          db
            .prepare(`SELECT request_id FROM api_requests WHERE space_handle=? AND space_epoch=? AND ${UNRESOLVED}`)
            .get(input.spaceHandle, input.spaceEpoch)
        )
          fail('request-pending');
        if (balances(db, input.spaceHandle, input.spaceEpoch).available < reserved) fail('insufficient-balance');
        db.prepare(`INSERT INTO api_requests(request_id,space_handle,space_epoch,state,reserved_nanoyuan,
          model,price_version,price_period,max_output_tokens,started_at) VALUES(?,?,?,'reserved',?,?,?,?,?,?)`).run(
          input.requestId,
          input.spaceHandle,
          input.spaceEpoch,
          Number(reserved),
          model,
          input.priceVersion,
          period,
          input.maxOutputTokens,
          startedAt,
        );
        const row = readRequest(db, input.requestId);
        return { isNew: true, request: presentRequest(row), state: row.state };
      });
    },

    /** 必须先成功提交 sent，再发送网络请求；sent 遗留只能进入待核对。 */
    markSent(requestId: string) {
      return immediate(db, () => {
        requireSchema(db);
        const row = readRequest(db, requestId);
        if (row.state !== 'reserved') fail('invalid-state');
        db.prepare("UPDATE api_requests SET state='sent',sent_at=? WHERE request_id=?").run(iso(now()), requestId);
        return presentRequest(readRequest(db, requestId));
      });
    },

    settle(input: {
      requestId: string;
      chargedNanoyuan: string | bigint;
      usage: ApiUsage;
      priceVersion: string;
      pricePeriod: PricePeriod;
      model?: string;
      upstreamId?: string;
    }) {
      identifier(input.requestId);
      identifier(input.priceVersion);
      const charge = amount(input.chargedNanoyuan);
      const period = pricePeriod(input.pricePeriod);
      const upstreamId = input.upstreamId === undefined ? null : identifier(input.upstreamId);
      return immediate(db, () => {
        requireSchema(db);
        const row = readRequest(db, input.requestId);
        const usage = validateUsage(input.usage, row.max_output_tokens);
        const model = input.model ?? row.model;
        if (model !== row.model || input.priceVersion !== row.price_version || period !== row.price_period)
          fail('settlement-conflict');
        if (charge > storedAmount(row.reserved_nanoyuan)) fail('over-reservation');
        if (row.state === 'settled') {
          const previous = presentRequest(row);
          if (
            previous.chargedNanoyuan !== charge.toString() ||
            JSON.stringify(previous.usage) !== JSON.stringify(usage) ||
            row.upstream_id !== upstreamId
          )
            fail('settlement-conflict');
          return previous;
        }
        if (row.state !== 'sent' && row.state !== 'pending') fail('invalid-state');
        const completedAt = iso(now());
        db.prepare(`INSERT INTO api_balance_events(event_id,space_handle,space_epoch,event_type,
          source_operation_id,request_id,amount_nanoyuan,created_at) VALUES(?,?,?,'charge',NULL,?,?,?)`).run(
          `charge:${input.requestId}`,
          row.space_handle,
          row.space_epoch,
          input.requestId,
          Number(charge),
          completedAt,
        );
        db.prepare(`UPDATE api_requests SET state='settled',charged_nanoyuan=?,completed_at=?,upstream_id=?,
          prompt_tokens=?,cache_hit_tokens=?,cache_miss_tokens=?,completion_tokens=?,total_tokens=?,reasoning_tokens=?,
          pending_reason=NULL WHERE request_id=?`).run(
          Number(charge),
          completedAt,
          upstreamId,
          usage.promptTokens,
          usage.cacheHitTokens,
          usage.cacheMissTokens,
          usage.completionTokens,
          usage.totalTokens,
          usage.reasoningTokens ?? null,
          input.requestId,
        );
        return presentRequest(readRequest(db, input.requestId));
      });
    },

    markPending(requestId: string, reason: string, metadata: { usage?: ApiUsage; upstreamId?: string } = {}) {
      if (!PENDING_REASONS.has(reason)) fail('invalid-request');
      return immediate(db, () => {
        requireSchema(db);
        const row = readRequest(db, requestId);
        if (row.state !== 'sent' && row.state !== 'pending') fail('invalid-state');
        const usage =
          metadata.usage === undefined
            ? presentRequest(row).usage
            : validateUsage(metadata.usage, row.max_output_tokens);
        const upstreamId = metadata.upstreamId === undefined ? row.upstream_id : identifier(metadata.upstreamId);
        if (row.upstream_id !== null && upstreamId !== row.upstream_id) fail('request-conflict');
        db.prepare(`UPDATE api_requests SET state='pending',pending_reason=?,upstream_id=?,
          prompt_tokens=?,cache_hit_tokens=?,cache_miss_tokens=?,completion_tokens=?,total_tokens=?,reasoning_tokens=?
          WHERE request_id=?`).run(
          reason,
          upstreamId,
          usage?.promptTokens ?? null,
          usage?.cacheHitTokens ?? null,
          usage?.cacheMissTokens ?? null,
          usage?.completionTokens ?? null,
          usage?.totalTokens ?? null,
          usage?.reasoningTokens ?? null,
          requestId,
        );
        return presentRequest(readRequest(db, requestId));
      });
    },

    releaseUnsent(requestId: string, reason = 'unsent') {
      if (!['unsent', 'client-disconnected', 'send-not-started'].includes(reason)) fail('invalid-request');
      return immediate(db, () => {
        requireSchema(db);
        const row = readRequest(db, requestId);
        if (row.state === 'released') return presentRequest(row);
        if (row.state !== 'reserved' || row.sent_at !== null) fail('invalid-state');
        db.prepare("UPDATE api_requests SET state='released',completed_at=? WHERE request_id=?").run(
          iso(now()),
          requestId,
        );
        return presentRequest(readRequest(db, requestId));
      });
    },

    /** 显式网关启动恢复；不得在只读管理查询构造时调用。 */
    recover() {
      return immediate(db, () => {
        requireSchema(db);
        const rows = db
          .prepare("SELECT request_id,state,sent_at FROM api_requests WHERE state IN ('reserved','sent')")
          .all() as { request_id: string; state: string; sent_at: string | null }[];
        let released = 0;
        let pending = 0;
        for (const row of rows) {
          if (row.state === 'reserved' && row.sent_at === null) {
            db.prepare("UPDATE api_requests SET state='released',completed_at=? WHERE request_id=?").run(
              iso(now()),
              row.request_id,
            );
            released++;
          } else {
            db.prepare(
              "UPDATE api_requests SET state='pending',pending_reason='restart-unknown' WHERE request_id=?",
            ).run(row.request_id);
            pending++;
          }
        }
        return { released, pending };
      });
    },
  };
}
