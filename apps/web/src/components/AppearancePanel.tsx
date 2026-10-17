import { useEffect, useRef, useState } from 'react';
import { type AppearanceApi, THEME_LABELS, type ThemeName } from '../lib/appearance';
import { BACKGROUND_GROUPS, getBackgroundPreset } from '../lib/background-presets';
import { useDialogActions } from './DialogShell';

interface Props {
  api: AppearanceApi;
  disabled: boolean;
}

/**
 * 个性化（设置弹窗里的一个大类）。
 *
 * 三件事都在这里：**色调**（酒馆 / 浅色 / 深色）、**对话区背景**（内置场景或自己选图，滑动时固定）、
 * 以及**心理活动要不要默认摊开**。
 *
 * 都只影响这台设备：偏好与自选图片在本机保存，不进同步、不进封存。
 */
export function AppearancePanel({ api, disabled }: Props) {
  const { setGuard } = useDialogActions();
  const [error, setError] = useState<string | null>(null);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundGroup, setBackgroundGroup] = useState(
    () => getBackgroundPreset(api.value.background)?.category ?? 'tavern',
  );
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { value } = api;
  const controlsDisabled = disabled || backgroundBusy;
  const activeGroup = BACKGROUND_GROUPS.find((group) => group.id === backgroundGroup);

  useEffect(() => {
    setGuard(backgroundBusy ? { kind: 'busy', message: '背景图片正在读取，请等待完成。' } : null);
    return () => setGuard(null);
  }, [backgroundBusy, setGuard]);

  const loadBackground = async (file: File): Promise<void> => {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setGuard({ kind: 'busy', message: '背景图片正在读取，请等待完成。' });
    setBackgroundBusy(true);
    setError(null);
    try {
      await api.setBackgroundFromFile(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBackgroundBusy(false);
      setGuard(null);
    }
  };

  return (
    <>
      <section className="panel">
        <h2>色调</h2>
        <p className="hint">外观修改即时预览，并自动保存在这台设备。选哪套都随时能换回来。</p>
        {api.persistenceError === null ? (
          <p className="hint" role="status">
            {api.hasSavedChanges ? '当前外观已保存在这台设备。' : '修改外观后会自动保存到这台设备。'}
          </p>
        ) : (
          <div className="notice error" role="alert">
            <p>外观保存失败，当前预览仅本次会话有效；重新打开时会使用此前保存的外观。{api.persistenceError}</p>
            <button type="button" disabled={controlsDisabled} onClick={api.retryPersist}>
              重试保存外观
            </button>
          </div>
        )}
        <div className="theme-grid">
          {(Object.keys(THEME_LABELS) as ThemeName[]).map((name) => {
            const meta = THEME_LABELS[name];
            return (
              <button
                key={name}
                type="button"
                className={value.theme === name ? 'theme-card active' : 'theme-card'}
                aria-pressed={value.theme === name}
                disabled={controlsDisabled}
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
        <p className="hint">先选题材，再选场景，可与任意色调搭配。内置图选用加载后可离线使用。</p>
        <p className="hint">背景随外观保存在这台设备。自选图片不会上传；滑动时背景固定。</p>

        <div className="background-picker">
          <fieldset className="background-subjects" aria-label="背景题材">
            {BACKGROUND_GROUPS.map((group) => (
              <button
                key={group.id}
                type="button"
                className={backgroundGroup === group.id ? 'background-subject active' : 'background-subject'}
                aria-pressed={backgroundGroup === group.id}
                disabled={controlsDisabled}
                onClick={() => setBackgroundGroup(group.id)}
              >
                {group.label}
              </button>
            ))}
          </fieldset>
          {activeGroup ? (
            <fieldset className="background-scenes" aria-label={`${activeGroup.label}场景`}>
              {activeGroup.presets.map((preset) => {
                const selected = value.background === preset.image;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={selected ? 'background-scene active' : 'background-scene'}
                    aria-label={preset.label}
                    aria-pressed={selected}
                    disabled={controlsDisabled}
                    onClick={() => {
                      setError(null);
                      api.patch({ background: preset.image });
                    }}
                  >
                    <img src={preset.thumbnail} alt="" loading="lazy" decoding="async" width="320" height="180" />
                    <span className="background-scene-copy">
                      <span className="background-scene-title">
                        <strong>{preset.label}</strong>
                        {selected ? (
                          <span className="background-scene-selected" aria-hidden="true">
                            已选
                          </span>
                        ) : null}
                      </span>
                      <span className="hint">{preset.description}</span>
                    </span>
                  </button>
                );
              })}
            </fieldset>
          ) : null}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden-file"
          disabled={controlsDisabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            return loadBackground(file);
          }}
        />

        <div className="save-bar">
          <button type="button" disabled={controlsDisabled} onClick={() => fileRef.current?.click()}>
            {backgroundBusy ? '读取中…' : '选一张图'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={controlsDisabled || value.background === ''}
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
                disabled={controlsDisabled}
                onChange={(event) => api.patch({ backgroundOpacity: Number(event.target.value) })}
              />
            </label>
          </>
        )}

        {error === null ? null : (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>对话显示</h2>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={value.showIntent}
            disabled={controlsDisabled}
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
