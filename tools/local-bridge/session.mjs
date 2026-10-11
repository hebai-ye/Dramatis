export function bindClientDisconnect(response, deadline) {
  const onClose = () => {
    if (!response.writableEnded) deadline.abort(new Error('客户端已断开。'));
  };
  response.on('close', onClose);
  return () => response.off('close', onClose);
}

export function createTargetGuard() {
  const uncertainIds = new Set();
  return {
    isUncertain(id) {
      return uncertainIds.has(id);
    },
    check(id) {
      if (typeof id !== 'string' || id === '') throw new Error('调试目标缺少稳定身份，拒绝发送。');
      if (uncertainIds.has(id))
        throw new Error('上次发送是否成功无法确认。请关闭这个模型标签页，新开独立标签后重试；不要自动重发。');
    },
    markUncertain(id) {
      uncertainIds.add(id);
    },
    clear(id) {
      uncertainIds.delete(id);
    },
  };
}
