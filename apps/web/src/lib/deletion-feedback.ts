export interface DeletionFeedback {
  ok: boolean;
  message: string;
  applied: boolean;
}

export async function deleteWithFeedback(
  remove: () => Promise<void>,
  refresh: () => Promise<void>,
): Promise<DeletionFeedback> {
  let applied = false;
  try {
    await remove();
    applied = true;
    await refresh();
    return { ok: true, message: '已删除本机归档对话。', applied };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      applied,
      message: applied ? `对话已删除，但列表刷新失败：${detail}。请重新打开列表核对。` : `删除失败：${detail}`,
    };
  }
}
