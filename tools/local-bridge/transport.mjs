import { createProcessSocket } from './process-socket.mjs';

export function timeoutError() {
  return new Error('本地助手操作超时（包括排队和网页通信）。');
}

export function createDeadline(timeoutMs, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  const expiresAt = now() + timeoutMs;
  const timer = setTimer(() => controller.abort(timeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    expiresAt,
    remaining: () => Math.max(0, expiresAt - now()),
    throwIfExpired() {
      if (controller.signal.aborted || now() >= expiresAt) throw controller.signal.reason ?? timeoutError();
    },
    abort(reason = new Error('客户端已断开。')) {
      controller.abort(reason);
    },
    close() {
      clearTimer(timer);
    },
  };
}

export function sleep(ms, deadline) {
  deadline.throwIfExpired();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      deadline.signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      cleanup();
      reject(deadline.signal.reason);
    };
    deadline.signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.min(ms, deadline.remaining()),
    );
  });
}

export async function fetchTargets(port, deadline, fetchImpl = fetch) {
  deadline.throwIfExpired();
  const response = await fetchImpl(`http://127.0.0.1:${String(port)}/json`, { signal: deadline.signal });
  deadline.throwIfExpired();
  if (!response.ok) throw new Error(`Chrome 的调试端口回了 ${String(response.status)}。`);
  const targets = await response.json();
  deadline.throwIfExpired();
  return targets;
}

async function closeSocket(socket, scheduler, closeTimeoutMs) {
  let closeExceeded = false;
  await new Promise((resolve) => {
    if (socket.readyState === 3) {
      resolve();
      return;
    }
    let timer;
    let completed = false;
    const cleanup = () => {
      scheduler.clearTimeout(timer);
      socket.removeEventListener('close', closedSocket);
    };
    const closedSocket = () => {
      if (completed) return;
      completed = true;
      cleanup();
      resolve();
    };
    const terminate = () => {
      closeExceeded = true;
      if (typeof socket.terminate !== 'function') return;
      void Promise.resolve()
        .then(() => socket.terminate())
        .then(() => {
          if (socket.readyState === 3) closedSocket();
        })
        .catch(() => {
          /* keep the lease until a real close event arrives */
        });
    };
    socket.addEventListener('close', closedSocket);
    timer = scheduler.setTimeout(terminate, closeTimeoutMs);
    try {
      socket.close();
      if (socket.readyState === 3) closedSocket();
    } catch {
      terminate();
    }
  });
  if (closeExceeded) throw new Error('调试通道关闭超时并已终止，目标状态不确定。');
}

export async function withCdp(
  target,
  work,
  {
    deadline,
    createSocket = createProcessSocket,
    commandTimeoutMs = 15_000,
    closeTimeoutMs = 1_500,
    scheduler = { setTimeout, clearTimeout },
  } = {},
) {
  deadline.throwIfExpired();
  const socket = createSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const unavailable = () => new Error('调试通道已断开。');
  function settleAll(error) {
    closed = true;
    for (const waiter of [...pending.values()]) waiter.reject(error);
  }
  const onClose = () => settleAll(unavailable());
  const onError = () => settleAll(new Error('调试通道发生错误。'));
  const onMessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiter = pending.get(payload.id);
    if (!waiter) return;
    if (payload.error) waiter.reject(new Error(`CDP 命令失败：${String(payload.error.message ?? payload.error.code)}`));
    else waiter.resolve(payload);
  };
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  socket.addEventListener('message', onMessage);
  try {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(deadline.signal.reason);
      };
      const onEarlyClose = () => {
        cleanup();
        reject(unavailable());
      };
      const onEarlyError = () => {
        cleanup();
        reject(new Error('连不上那个标签页的调试通道。'));
      };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('close', onEarlyClose);
        socket.removeEventListener('error', onEarlyError);
        deadline.signal.removeEventListener('abort', onAbort);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('close', onEarlyClose);
      socket.addEventListener('error', onEarlyError);
      deadline.signal.addEventListener('abort', onAbort, { once: true });
      if (deadline.signal.aborted) onAbort();
    });
    const call = (method, params = {}, onSent) => {
      deadline.throwIfExpired();
      if (closed) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        const id = nextId++;
        let timer;
        const cleanup = () => {
          pending.delete(id);
          scheduler.clearTimeout(timer);
          deadline.signal.removeEventListener('abort', aborted);
        };
        const waiter = {
          resolve(value) {
            cleanup();
            resolve(value);
          },
          reject(error) {
            cleanup();
            reject(error);
          },
        };
        const aborted = () => waiter.reject(deadline.signal.reason);
        pending.set(id, waiter);
        deadline.signal.addEventListener('abort', aborted, { once: true });
        timer = scheduler.setTimeout(
          () => waiter.reject(timeoutError()),
          Math.min(commandTimeoutMs, deadline.remaining()),
        );
        try {
          deadline.throwIfExpired();
          onSent?.();
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          waiter.reject(error);
        }
      });
    };
    return await work(call);
  } finally {
    settleAll(unavailable());
    socket.removeEventListener('message', onMessage);
    try {
      await closeSocket(socket, scheduler, closeTimeoutMs);
    } finally {
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    }
  }
}
