import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { importRecoveryWarnings } from '../lib/session';
import { ImportRecoveryNotice } from './ImportRecoveryNotice';

describe('import recovery notice', () => {
  it('consumes only warnings actually returned by the core contract', () => {
    expect(importRecoveryWarnings({})).toEqual([]);
    const warnings = importRecoveryWarnings({
      warnings: [
        {
          code: 'invalid-marker',
          message: '导入标记无法识别，请检查导入记录。',
          markerId: 'marker-1',
          rawMarker: 'PRIVATE VALUE',
        },
      ],
    });
    expect(warnings).toEqual([
      {
        code: 'invalid-marker',
        message: '导入标记无法识别，请检查导入记录。',
        markerId: 'marker-1',
      },
    ]);
    const html = renderToStaticMarkup(<ImportRecoveryNotice recoveredImports={0} warnings={warnings} />);
    expect(html).toContain('导入恢复检查需要处理');
    expect(html).toContain('导入标记无法识别');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('PRIVATE VALUE');
    expect(html).not.toContain('marker-1');
    expect(html).not.toContain('已撤掉');
  });

  it('reports only completed rollbacks and renders no notice for the legacy successful contract', () => {
    expect(renderToStaticMarkup(<ImportRecoveryNotice recoveredImports={0} warnings={[]} />)).toBe('');
    const html = renderToStaticMarkup(<ImportRecoveryNotice recoveredImports={2} warnings={[]} />);
    expect(html).toContain('已撤掉 2 个未完成导入的世界');
    expect(html).not.toContain('需要处理');
  });

  it('replaces malformed warning data with neutral readable text', () => {
    const warnings = importRecoveryWarnings({ warnings: [{ rawMarker: 'PRIVATE VALUE' }] });
    expect(warnings[0]?.code).toBe('invalid-recovery-report');
    const html = renderToStaticMarkup(<ImportRecoveryNotice recoveredImports={0} warnings={warnings} />);
    expect(html).toContain('请检查现有世界');
    expect(html).not.toContain('PRIVATE VALUE');
    expect(html).not.toContain('已有世界保留');
  });
});
