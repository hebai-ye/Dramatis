import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';

/**
 * 文本字段的「本地草稿 + 防抖提交」（顺序 63）。
 *
 * 背景：以前场景名、角色显示名、对话名、记忆正文这些输入框都是**每敲一个字就写一次库**
 * （`onChange` 直接调 `session.updateX`）。后果有三条：仓储被无谓地写很多次、每条写入都会
 * 重建快照（顺序 62 量过：一次写入就是一次整表重画的机会）、而且**输入法/手写会被打断**——
 * 落一个笔画回写一次，父组件把旧值盖回来，组合就断了（顺序 54 修过一次）。
 *
 * 这一版把 `PersonaLibrary` 里那套已经在用的做法抽出来给所有文本框共用：
 *
 * - **打字只改本地草稿**，不碰仓储；
 * - 停手 `delay`（默认 300ms）之后提交一次；
 * - **失焦立刻提交**（不清空、不回退）；
 * - 输入法组合期（`compositionstart` → `compositionend`，以及 `nativeEvent.isComposing`）
 *   一个字节都不提交，组合结束再排一次提交；
 * - 提交过的值记在 `savedRef` 里，**同一个值不重复提交**；
 * - 焦点还在输入框里时，父组件回写的新值不会把草稿盖掉（否则中文输入会被打断）。
 */
export interface UseDraftFieldOptions {
  /** 父组件手里那份「已经保存的值」。 */
  value: string;
  /** 真正落库的那一次（防抖到点、或失焦时调）。 */
  commit: (value: string) => void;
  /** 防抖间隔，默认 300ms。 */
  delay?: number;
}

export interface DraftField {
  /** 直接摊给 `<input>` / `<textarea>` 的属性（value + 五个事件）。 */
  bind: {
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** 立刻提交（比如按了回车）。 */
  flush: () => void;
}

export function useDraftField({ value, commit, delay = 300 }: UseDraftFieldOptions): DraftField {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const savedRef = useRef(value);
  const focusedRef = useRef(false);
  const composingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  /** 提交函数放 ref：调用方每次渲染新造一个箭头函数也不会让计时器失效。 */
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (draftRef.current === value) return;
    // 焦点还在、或正在组合：绝不用外面回写的旧值盖掉草稿
    if (focusedRef.current || composingRef.current) return;
    draftRef.current = value;
    savedRef.current = value;
    setDraft(value);
  }, [value]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  /** 到点或失焦时的那一次提交：值没变、或还在组合，就什么都不做。 */
  const flush = useCallback((): void => {
    clearTimer();
    if (composingRef.current) return;
    const current = draftRef.current;
    if (current === savedRef.current) return;
    savedRef.current = current;
    commitRef.current(current);
  }, [clearTimer]);

  const queue = useCallback((): void => {
    clearTimer();
    if (composingRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (composingRef.current) return;
      const current = draftRef.current;
      if (current === savedRef.current) return;
      savedRef.current = current;
      commitRef.current(current);
    }, delay);
  }, [clearTimer, delay]);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const next = event.target.value;
      draftRef.current = next;
      setDraft(next);
      // 一些浏览器在组合期不派发 compositionend，只在事件上带 isComposing
      const nativeComposing = (event.nativeEvent as InputEvent).isComposing === true;
      if (composingRef.current || nativeComposing) return;
      queue();
    },
    [queue],
  );

  const onFocus = useCallback((): void => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback((): void => {
    focusedRef.current = false;
    flush();
  }, [flush]);

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true;
    clearTimer();
  }, [clearTimer]);

  const onCompositionEnd = useCallback((): void => {
    composingRef.current = false;
    queue();
  }, [queue]);

  return {
    bind: { value: draft, onChange, onFocus, onBlur, onCompositionStart, onCompositionEnd },
    flush,
  };
}
