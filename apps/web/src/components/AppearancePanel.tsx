import { useRef, useState } from 'react';
import { type AppearanceApi, THEME_LABELS, type ThemeName } from '../lib/appearance';

interface Props {
  api: AppearanceApi;
  disabled: boolean;
}

/**
 * 个性化（设置弹窗里的一个大类）。
 *
 * 三件事都在这里：**色调**（酒馆 / 浅色 / 深色）、**对话区背景**（自己选图，滑动时固定）、
 * 以及**心理活动要不要默认摊开**。
 *
 * 都只影响这台设备：图片与偏好存在 localStorage，不进同步、不进封存。
 */
export function AppearancePanel({ api, disabled }: Props) {
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { value } = api;

  return (
    <>
      <section className="panel">
        <h2>色调</h2>
        <p className="hint">只换颜色，不动布局。选哪套都随时能换回来。</p>
        <div className="theme-grid">
          {(Object.keys(THEME_LABELS) as ThemeName[]).map((name) => {
            const meta = THEME_LABELS[name];
            return (
              <button
                key={name}
                type="button"
                className={value.theme === name ? 'theme-card active' : 'theme-card'}
                disabled={disabled}
                onClick={() => api.patch({ theme: name })}
              >
                <span
                  className="theme-swatch"
                  style={{ background: `linear-gradient(135deg, ${meta.swatch[0]} 55%, ${meta.swatch[1]} 55%)` }}
                />
                <strong>{meta.label}</strong>
                <span className="hint">{meta.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2>对话区背景</h2>
        <p className="hint">
          可以放一张自己的图。<strong>滑动时背景固定，只有对话在滚</strong>
          。图片只存在这台设备上——不同步、不上传，导出封存时也不带它。
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setError(null);
            void api.setBackgroundFromFile(file).catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        />

        <div className="save-bar">
          <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}>
            选一张图
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || value.background === ''}
            onClick={() => api.patch({ background: '' })}
          >
            清除背景
          </button>
        </div>

        {value.background === '' ? (
          <p className="hint">现在是纯色背景。</p>
        ) : (
          <>
            <div
              className="bg-preview"
              style={{ backgroundImage: `url("${value.background}")`, opacity: value.backgroundOpacity }}
            />
            <label>
              背景强度（{Math.round(value.backgroundOpacity * 100)}%）
              <input
                type="range"
                min="0.2"
                max="1"
                step="0.05"
                value={value.backgroundOpacity}
                disabled={disabled}
                onChange={(event) => api.patch({ backgroundOpacity: Number(event.target.value) })}
              />
            </label>
          </>
        )}

        {error === null ? null : <div className="notice error">{error}</div>}
      </section>

      <section className="panel">
        <h2>对话显示</h2>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={value.showIntent}
            disabled={disabled}
            onChange={(event) => api.patch({ showIntent: event.target.checked })}
          />
          <span>
            角色的心理活动默认展开
            <span className="hint">默认是收起的：气泡上方只写「他这一轮想做什么（点开看）」，点一下才看得见内容。</span>
          </span>
        </label>
      </section>
    </>
  );
}
