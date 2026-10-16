import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 布局规划页。
 *
 * 目的很窄：把草图的骨架还原成一比一的空位，让设计者直接在每个区域里
 * 写下「这里负责什么」，然后一次性复制成结构化文本。之所以单独做一页
 * 而不是塞进应用里，是因为它是设计阶段的临时工具，不该混进产品流程。
 */
interface RegionSpec {
  id: string;
  label: string;
  hint: string;
}

const REGIONS: RegionSpec[] = [
  { id: 'topLeftIcon', label: '顶栏 · 左上控件', hint: '这个方块是什么？（菜单？折叠？）' },
  { id: 'topbar', label: '顶栏 · 其余部分', hint: '顶栏整体负责什么？放哪些东西？' },
  { id: 'leftHeader', label: '左栏 · 顶部', hint: '标题？分区标签？搜索？' },
  { id: 'leftBody', label: '左栏 · 中间（可滚动）', hint: '主体内容' },
  { id: 'leftFooter', label: '左栏 · 底部', hint: '设置入口？状态信息？导入按钮？' },
  { id: 'mainHeader', label: '主区 · 标题栏', hint: '显示什么？' },
  { id: 'mainHeaderIcon', label: '主区标题栏 · 右上控件', hint: '这个方块干什么？（开合右侧面板？）' },
  { id: 'mainBody', label: '主区 · 内容', hint: '对话流？' },
  { id: 'composer', label: '输入区', hint: '输入框与发送键的职责' },
  { id: 'rightRail', label: '右缘窄栏', hint: '如果那条竖线只是草稿纸格线，这里留空即可' },
  { id: 'other', label: '其他说明', hint: '比例、交互、你觉得该说清楚的任何事' },
];

const STORAGE_KEY = 'dramatis.plan.v1';

const FALLBACK_REGION: RegionSpec = { id: 'unknown', label: '未命名区域', hint: '' };

function loadNotes(): { notes: Record<string, string>; error: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { notes: {}, error: null };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('规划格式无效');
    const notes = Object.fromEntries(
      REGIONS.flatMap(({ id }) => {
        const value = (parsed as Record<string, unknown>)[id];
        return typeof value === 'string' ? [[id, value]] : [];
      }),
    );
    return { notes, error: null };
  } catch {
    return { notes: {}, error: '本机规划读取失败。原存储尚未覆盖；请检查浏览器存储，或重新填写后复制文本留存。' };
  }
}

function Region({
  spec,
  value,
  onChange,
  className,
}: {
  spec: RegionSpec;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`plan-region ${className ?? ''}`}>
      <label className="plan-label" htmlFor={`plan-${spec.id}`}>
        {spec.label}
      </label>
      <textarea
        id={`plan-${spec.id}`}
        value={value}
        placeholder={spec.hint}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function PlanPage() {
  const [initial] = useState(loadNotes);
  const [notes, setNotes] = useState<Record<string, string>>(initial.notes);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const [copyNotice, setCopyNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const reportRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (initial.error !== null && notes === initial.notes) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      setStorageError(null);
    } catch {
      setStorageError('本机保存失败。内容仍在当前页面，请先复制规划文本或手动选中文本留存，再关闭页面。');
    }
  }, [notes, initial]);

  const set = useCallback((id: string, value: string) => {
    setNotes((previous) => ({ ...previous, [id]: value }));
    setCopyNotice(null);
  }, []);

  const report = useMemo(() => {
    const sections = REGIONS.filter((spec) => (notes[spec.id] ?? '').trim() !== '').map(
      (spec) => `### ${spec.label}\n${(notes[spec.id] ?? '').trim()}`,
    );
    return sections.length === 0 ? '（还没有填写任何内容）' : ['# 布局规划', '', ...sections].join('\n\n');
  }, [notes]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyNotice({ ok: true, message: '已复制规划文本。' });
    } catch {
      setCopyNotice({ ok: false, message: '复制失败。请点击「手动选择规划文本」，再使用系统复制操作。' });
      reportRef.current?.focus();
      reportRef.current?.select();
    }
  };

  const region = (id: string): RegionSpec => REGIONS.find((spec) => spec.id === id) ?? FALLBACK_REGION;

  return (
    <div className="plan-page">
      <div className="plan-toolbar">
        <strong>布局规划</strong>
        <span className="hint">
          在对应位置写下它负责什么。{storageError === null ? '内容已保存在本机。' : '本机存储暂不可用。'}
        </span>
        <div className="topbar-spacer" />
        <button type="button" onClick={copy}>
          复制规划文本
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            if (window.confirm('清空全部规划内容及本机保存？此操作无法撤销。')) {
              setNotes({});
              setCopyNotice(null);
            }
          }}
        >
          清空
        </button>
        <button type="button" className="ghost" onClick={() => window.location.assign('/')}>
          回到应用
        </button>
      </div>
      {storageError === null ? null : (
        <p className="notice error" role="alert">
          {storageError}
        </p>
      )}
      {copyNotice === null ? null : (
        <p className={copyNotice.ok ? 'hint' : 'notice error'} role={copyNotice.ok ? 'status' : 'alert'}>
          {copyNotice.message}
        </p>
      )}

      {/* 骨架按草图的线条与比例还原：窄顶栏、左栏分三段、主区带自己的标题栏、底部输入框 */}
      <div className="plan-frame">
        <div className="plan-topbar">
          <Region
            spec={region('topLeftIcon')}
            value={notes.topLeftIcon ?? ''}
            onChange={(value) => set('topLeftIcon', value)}
            className="plan-icon-slot"
          />
          <Region
            spec={region('topbar')}
            value={notes.topbar ?? ''}
            onChange={(value) => set('topbar', value)}
            className="plan-topbar-main"
          />
        </div>

        <div className="plan-body">
          <div className="plan-left">
            <Region
              spec={region('leftHeader')}
              value={notes.leftHeader ?? ''}
              onChange={(value) => set('leftHeader', value)}
            />
            <Region
              spec={region('leftBody')}
              value={notes.leftBody ?? ''}
              onChange={(value) => set('leftBody', value)}
            />
            <Region
              spec={region('leftFooter')}
              value={notes.leftFooter ?? ''}
              onChange={(value) => set('leftFooter', value)}
            />
          </div>

          <div className="plan-right">
            <div className="plan-main-header">
              <Region
                spec={region('mainHeader')}
                value={notes.mainHeader ?? ''}
                onChange={(value) => set('mainHeader', value)}
                className="plan-main-header-text"
              />
              <Region
                spec={region('mainHeaderIcon')}
                value={notes.mainHeaderIcon ?? ''}
                onChange={(value) => set('mainHeaderIcon', value)}
                className="plan-icon-slot"
              />
            </div>

            <div className="plan-main-area">
              <div className="plan-main">
                <Region
                  spec={region('mainBody')}
                  value={notes.mainBody ?? ''}
                  onChange={(value) => set('mainBody', value)}
                />
                <div className="plan-composer-wrap">
                  <Region
                    spec={region('composer')}
                    value={notes.composer ?? ''}
                    onChange={(value) => set('composer', value)}
                    className="plan-composer"
                  />
                </div>
              </div>
              <Region
                spec={region('rightRail')}
                value={notes.rightRail ?? ''}
                onChange={(value) => set('rightRail', value)}
                className="plan-rail"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="plan-extra">
        <Region spec={region('other')} value={notes.other ?? ''} onChange={(value) => set('other', value)} />
      </div>

      <section className="plan-report">
        <label htmlFor="plan-report-text">规划文本预览（可手动复制）</label>
        <textarea id="plan-report-text" ref={reportRef} readOnly value={report} rows={10} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            reportRef.current?.focus();
            reportRef.current?.select();
          }}
        >
          手动选择规划文本
        </button>
      </section>
    </div>
  );
}
