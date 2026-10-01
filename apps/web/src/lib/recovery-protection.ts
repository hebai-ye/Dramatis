/** 请求浏览器在刷新/关闭前提示；恢复码只由调用方内存持有。 */
export function protectUnsavedRecovery(readCode: () => string | null, target: EventTarget): () => void {
  const beforeUnload = (event: Event): void => {
    if (readCode() === null) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '恢复码尚未安全保存。';
  };
  target.addEventListener('beforeunload', beforeUnload);
  return () => target.removeEventListener('beforeunload', beforeUnload);
}
