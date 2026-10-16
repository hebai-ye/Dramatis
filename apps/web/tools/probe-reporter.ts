/** Visible summary for synthetic development probes; no cancellation is advertised. */
export function createProbeReporter(dataLabel: string) {
  const out = document.querySelector('#out');
  const status = document.querySelector('#probe-status');
  const data = document.querySelector('#probe-data');
  const lines: string[] = [];
  let passed = 0;
  let failed = 0;
  const started = performance.now();
  if (data !== null) data.textContent = dataLabel;
  const update = (state: 'running' | 'passed' | 'failed') => {
    if (status === null) return;
    const label = state === 'running' ? '运行中' : state === 'passed' ? '通过' : '失败';
    status.textContent = `${label} · 检查通过 ${passed} / 失败 ${failed}${state === 'running' ? '' : ` · ${(performance.now() - started).toFixed(0)} ms`}`;
    status.setAttribute('data-state', state);
  };
  const log = (text: string) => {
    lines.push(text);
    if (out !== null) out.textContent = lines.join('\n');
  };
  update('running');
  return {
    log,
    check(label: string, ok: boolean, detail?: string): void {
      if (ok) passed += 1;
      else failed += 1;
      log(`${ok ? '✅' : '❌'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`);
      update('running');
    },
    finish(): void {
      update(failed === 0 ? 'passed' : 'failed');
    },
    fail(error: unknown): void {
      failed += 1;
      log(`探针失败：${error instanceof Error ? error.message : String(error)}`);
      update('failed');
    },
  };
}
