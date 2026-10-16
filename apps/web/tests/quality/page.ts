import * as baselineAdmin from 'virtual:validation-baseline-admin';
import { scrub } from './evidence';
import { readExecutionProfile } from './execution-profile';
import { makeBlindSamples, type NeutralBackground, type QualityManifest, scoreDownload } from './presentation';
import { runFixture } from './runner';
import type { Family, QualityResult } from './types';
import './style.css';

interface HostStatus {
  mode: 'locked' | 'fake' | 'real';
  real: { requests: number; qualityRequests: number; spentCny: number; halted: boolean };
  fake: { requests: number };
  executionProfile: unknown;
  checkpointHash?: string;
}
interface BlindEvidence extends Omit<QualityResult, 'requestHash' | 'fixtureHash'> {
  blindId: string;
  family: Family;
  repeat: number;
  mode: HostStatus['mode'];
  background: NeutralBackground;
}
interface HumanScore {
  blindId: string;
  mode: HostStatus['mode'];
  background: NeutralBackground;
  assessor: string;
  evidence: string;
  rubric: Record<string, string>;
  taskCorrectness: string;
}
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw Error(`Missing element: ${id}`);
  return element as T;
};
const value = (id: string) => el<HTMLInputElement>(id).value;
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/validation-api/${route}`,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  const result: unknown = await response.json();
  if (!response.ok) throw Error('validation-request-rejected');
  return result as T;
}
const manifest = await api<QualityManifest>('manifest');
const samples = makeBlindSamples(manifest);
const records: BlindEvidence[] = [];
const scores: HumanScore[] = [];
let controller: AbortController | null = null;
let last: BlindEvidence | null = null;
const rubricNames = ['像人说话', '性格一致', '经历/记忆一致', '不越界', '没有 AI 腔'];
rubricNames.forEach((name, i) => {
  const label = document.createElement('label');
  label.textContent = name;
  const select = document.createElement('select');
  select.id = `score${i}`;
  for (const option of ['N/A', '0', '1', '2']) select.add(new Option(option, option));
  label.append(select);
  el('rubric').append(label);
});
samples.forEach((sample, i) => {
  el<HTMLSelectElement>('sample').add(new Option(`${sample.blindId} · ${sample.fixture.family}`, String(i)));
});
function selectedSample() {
  const sample = samples[Number(value('sample'))];
  if (!sample) throw Error('missing-sample');
  return sample;
}
function showBackground() {
  el('background').textContent = JSON.stringify(selectedSample().background, null, 2);
}
el('sample').addEventListener('change', () => {
  if (controller) return;
  last = null;
  el('result').textContent = '';
  showBackground();
});
async function refresh(): Promise<HostStatus> {
  const status = await api<HostStatus>('status');
  el('budget').textContent =
    `模式：${status.mode} | 真实 ${status.real.requests}/48；¥${status.real.spentCny.toFixed(6)}/5\n余量 ${48 - status.real.requests} 请求 / ¥${Math.max(0, 5 - status.real.spentCny).toFixed(6)}；质量 ${status.real.qualityRequests}/44；停止锁 ${status.real.halted}\nFake ${status.fake.requests} 次（独立零成本测试账，不算真实样本）\n总账 checkpoint：${status.checkpointHash ?? '未提供'}`;
  try {
    const profile = readExecutionProfile(status.executionProfile);
    el('executionProfile').textContent =
      `服务器执行 profile：${profile.profileId} · ${profile.model} / ${profile.reasoningEffort} · thinking enabled · max_tokens ${profile.maxOutputTokens}（含 reasoning）。双方管理员使用同一 profile；历史 fixture 仍为 1200，原 requestHash 保留，实际 client wireHash 与 upstreamWireHash 单独记录。`;
    el<HTMLButtonElement>('run').disabled = false;
  } catch (error) {
    el('executionProfile').textContent = '服务器执行 profile 缺失、不受支持或参数不一致；发送已禁用。';
    el<HTMLButtonElement>('run').disabled = true;
    throw error;
  }
  return status;
}
function action(id: string, fn: () => Promise<void> | void) {
  el(id).addEventListener('click', () => {
    Promise.resolve()
      .then(fn)
      .catch(() => {
        el('result').textContent = '操作被拒绝或失败；请检查总账与 host 状态。未自动重试。';
      });
  });
}
action('clear', () => {
  controller?.abort();
  el<HTMLInputElement>('key').value = '';
  el('result').textContent = 'Key 已清除；预算不重置。';
});
action('fake', async () => {
  await api('arm', { mode: 'fake', fakeScenario: value('fakeScenario'), resetFake: true });
  await refresh();
});
action('arm', async () => {
  if (!value('key').trim()) throw Error('key-required');
  await api('arm', { mode: 'real', upstream: value('upstream') });
  await refresh();
});
action('lock', async () => {
  controller?.abort();
  await api('arm', { mode: 'locked' });
  await refresh();
});
action('stop', () => controller?.abort());
action('run', async () => {
  if (controller) return;
  const status = await refresh();
  const executionProfile = readExecutionProfile(status.executionProfile);
  if (status.mode === 'locked' || (status.real.halted && status.mode === 'real')) throw Error('locked');
  const sample = selectedSample();
  if (records.some((row) => row.blindId === sample.blindId && row.mode === 'real') && status.mode === 'real')
    throw Error('already-completed');
  controller = new AbortController();
  el<HTMLSelectElement>('sample').disabled = true;
  try {
    const result = await runFixture(
      sample.fixture,
      {
        apiKey: status.mode === 'real' ? value('key') : 'fake-key',
        baseUrl: `${location.origin}/validation-api/v1`,
        headers: { 'x-validation-purpose': 'quality' },
      },
      controller.signal,
      sample.side === 'baseline' || sample.side === 'shared' ? baselineAdmin : undefined,
      { executionProfile, requireServerEvidence: true },
    );
    last = {
      blindId: sample.blindId,
      caseId: result.caseId,
      family: sample.fixture.family,
      repeat: sample.repeat,
      mode: status.mode,
      background: sample.background,
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
      parse: result.parse,
      rounds: result.rounds,
      error: result.error,
      admin: result.admin,
    };
    records.push(last);
    el('result').textContent = JSON.stringify(
      {
        blindId: last.blindId,
        text: last.text,
        toolCalls: last.toolCalls,
        usage: last.usage,
        parse: last.parse,
        error: last.error,
      },
      null,
      2,
    );
  } finally {
    controller = null;
    el<HTMLSelectElement>('sample').disabled = false;
    await refresh();
  }
});
action('saveScore', () => {
  if (!last || !value('assessor').trim() || !value('scoreEvidence').trim()) throw Error('score-incomplete');
  const score: HumanScore = {
    blindId: last.blindId,
    mode: last.mode,
    background: last.background,
    assessor: value('assessor'),
    evidence: value('scoreEvidence'),
    rubric: Object.fromEntries(rubricNames.map((name, i) => [name, value(`score${i}`)])),
    taskCorrectness: value('taskScore'),
  };
  scores.push(scrub(score, value('key')) as HumanScore);
  el('result').textContent = `已记录 ${last.blindId} 人工评分；N/A 不计满分。`;
});
function download(name: string, rows: readonly unknown[]) {
  const url = URL.createObjectURL(new Blob([scoreDownload(rows, value('key'))], { type: 'application/x-ndjson' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
action('downloadRaw', () => download('quality-raw.jsonl', records));
action('downloadScores', () => download('quality-human-scores.jsonl', scores));
action('downloadMap', () =>
  download(
    'quality-unblind.jsonl',
    samples.map(({ blindId, side, repeat, fixture }) => ({
      blindId,
      side,
      repeat,
      caseId: fixture.caseId,
      requestHash: fixture.requestHash,
      fixtureHash: fixture.fixtureHash,
      commit: fixture.commit,
    })),
  ),
);
action('downloadLedger', async () => download('validation-ledger.jsonl', [await refresh()]));
window.addEventListener('securitypolicyviolation', (event) => {
  void api('violation', { directive: event.effectiveDirective, disposition: event.disposition });
});
window.addEventListener('pagehide', () => {
  controller?.abort();
  el<HTMLInputElement>('key').value = '';
});
el('byok').textContent = `${location.origin}/validation-api/v1`;
showBackground();
await refresh();
el('ready').textContent = '准备完成 · 默认不发送 · 真实 Key 只由用户输入';
