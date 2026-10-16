import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { runPageAsk, runTargetAsk, waitForReply } from './ask-flow.mjs';
import { createSerialQueue } from './policy.mjs';
import { ProcessSocket } from './process-socket.mjs';
import { bindClientDisconnect, createTargetGuard } from './session.mjs';
import { captureBaseline, observeReply, readSnapshot } from './site-adapter.mjs';
import { createDeadline, fetchTargets, withCdp } from './transport.mjs';

const user = (id, body) => ({ id, role: 'user', body, terminal: true });
const assistant = (id, body, terminal = true) => ({ id, role: 'assistant', body, terminal });
const snap = (messages, generating = false) => ({ supported: true, messages, generating });

describe('strict reply identity and completion', () => {
  it('waits through six seconds of unchanged generating text and then three terminal polls', async () => {
    const base = captureBaseline(snap([]));
    const generating = snap([user('u1', 'prompt'), assistant('a1', 'draft', false)], true);
    const terminal = snap([user('u1', 'prompt'), assistant('a1', 'finished')]);
    const frames = [...Array(5).fill(generating), terminal, terminal, terminal];
    let elapsed = 0;
    let reads = 0;
    const deadline = createDeadline(30_000);
    const text = await waitForReply(() => {}, base, 'prompt', deadline, {
      sleepFn: async (ms) => {
        elapsed += ms;
      },
      readSnapshotFn: async () => {
        reads += 1;
        return frames.shift();
      },
    });
    assert.equal(text, 'finished');
    assert.equal(reads, 8);
    assert.equal(elapsed, 9_600);
    deadline.close();
  });
  it('reads a thinking DOM marker through the actual snapshot expression and rejects it', async () => {
    const body = { innerText: 'answer' };
    const message = {
      getAttribute: (name) =>
        ({ 'data-message-id': 'a1', 'data-role': 'assistant', 'data-terminal': 'true' })[name] ?? null,
      querySelector: (selector) => (selector === '[data-thinking]' ? {} : body),
    };
    const root = {
      getAttribute: () => 'false',
      querySelectorAll: () => [message],
    };
    const document = { querySelector: () => root };
    const call = async (_method, { expression }) => ({
      result: { result: { value: runInNewContext(expression, { document }) } },
    });
    const snapshot = await readSnapshot(call);
    assert.equal(snapshot.supported, false);
    assert.throws(() => captureBaseline(snapshot), /思考区/);
  });
  it('rejects old assistant/user and an unmatched new user', () => {
    const base = captureBaseline(snap([user('u0', 'prompt'), assistant('a0', 'old')]));
    const state = observeReply(base, snap([user('u0', 'prompt'), assistant('a0', 'old')]), 'prompt');
    assert.equal(state.done, false);
    assert.equal(
      observeReply(
        base,
        snap([user('u0', 'prompt'), assistant('a0', 'old'), user('u1', 'other'), assistant('a1', 'reply')]),
        'prompt',
      ).done,
      false,
    );
  });
  it('requires a new assistant after this prompt and explicit terminal even after three quiet polls', () => {
    const base = captureBaseline(snap([assistant('a0', 'same')]));
    const middle = snap([assistant('a0', 'same'), user('u1', 'prompt'), assistant('a1', 'same', false)], true);
    for (let i = 0; i < 5; i++) assert.equal(observeReply(base, middle, 'prompt').done, false);
    const ready = snap([assistant('a0', 'same'), user('u1', 'prompt'), assistant('a1', 'same')]);
    assert.equal(observeReply(base, ready, 'prompt').done, true);
  });
  it('rejects empty body, reused identity, missing generation state and thinking content', () => {
    const base = captureBaseline(snap([assistant('a0', 'old')]));
    assert.equal(
      observeReply(base, snap([assistant('a0', 'old'), user('u1', 'prompt'), assistant('a1', '')]), 'prompt').done,
      false,
    );
    assert.throws(
      () =>
        observeReply(
          base,
          snap([assistant('a0', 'changed'), user('u1', 'prompt'), assistant('a1', 'reply')]),
          'prompt',
        ),
      /身份|变化/,
    );
    assert.throws(() => observeReply(base, { supported: true, messages: [], generating: null }, 'prompt'), /生成状态/);
    assert.throws(() => captureBaseline({ supported: false, reason: '思考区无法区分' }), /思考区/);
  });
  it('rejects a vanished message and a reused new identity', () => {
    const base = captureBaseline(snap([]));
    observeReply(base, snap([user('u1', 'prompt'), assistant('a1', 'draft', false)], true), 'prompt');
    assert.throws(() => observeReply(base, snap([user('u1', 'prompt'), user('a1', 'changed')]), 'prompt'), /身份/);
    const second = captureBaseline(snap([]));
    observeReply(second, snap([user('u1', 'prompt')]), 'prompt');
    assert.throws(() => observeReply(second, snap([]), 'prompt'), /截断|消失/);
  });
  it('rejects mutation of the new user identity after matching the prompt', () => {
    const base = captureBaseline(snap([]));
    observeReply(base, snap([user('u1', 'prompt')]), 'prompt');
    assert.throws(
      () => observeReply(base, snap([user('u1', 'other'), assistant('a1', 'reply')]), 'prompt'),
      /身份|变化/,
    );
  });
  it('rejects an assistant after another user or an ambiguous new turn', () => {
    const base = captureBaseline(snap([]));
    assert.throws(
      () =>
        observeReply(base, snap([user('u1', 'prompt'), user('u2', 'other'), assistant('a2', 'wrong turn')]), 'prompt'),
      /归属|交错|歧义/,
    );
    const second = captureBaseline(snap([]));
    assert.throws(
      () => observeReply(second, snap([user('u1', 'prompt'), assistant('a1', 'first'), user('u2', 'other')]), 'prompt'),
      /归属|交错|歧义/,
    );
  });
});

describe('deadline and serial queue', () => {
  it('expires a queued task without executing it or releasing the active lease early', async () => {
    const queue = createSerialQueue();
    let release;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const deadline = createDeadline(20);
    let executed = false;
    await assert.rejects(
      queue.run(
        () => {
          executed = true;
        },
        { signal: deadline.signal, deadline },
      ),
      /超时/,
    );
    assert.equal(executed, false);
    assert.equal(queue.pending, 1);
    release('done');
    await first;
    assert.equal(queue.pending, 0);
  });
  it('keeps the lease until aborted work has cleaned up', async () => {
    const queue = createSerialQueue();
    const deadline = createDeadline(15);
    let release;
    let secondStarted = false;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { signal: deadline.signal, deadline },
    );
    const second = queue.run(() => {
      secondStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondStarted, false);
    release('done');
    await first;
    await second;
    assert.equal(secondStarted, true);
  });
  it('uses deadline.signal when only a deadline is supplied', async () => {
    const queue = createSerialQueue();
    let release;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const deadline = createDeadline(15);
    let executed = false;
    const queued = queue.run(
      () => {
        executed = true;
      },
      { deadline },
    );
    try {
      const outcome = await Promise.race([
        queued.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise((resolve) => setTimeout(() => resolve('still queued'), 35)),
      ]);
      assert.equal(outcome, 'rejected');
      assert.equal(executed, false);
      assert.equal(queue.pending, 1);
    } finally {
      release();
      await first;
      await queued.catch(() => {});
      deadline.close();
    }
  });
});

describe('request and target state', () => {
  it('keeps the target locked after the click command loses its acknowledgement through page ask', async () => {
    const guard = createTargetGuard();
    const deadline = createDeadline(100);
    let commands = 0;
    const call = async (method, params, onSent) => {
      commands += 1;
      if (method === 'Runtime.enable') return { result: {} };
      if (params.expression.includes('data-local-bridge-root')) return { result: { result: { value: snap([]) } } };
      if (params.expression.includes('data-local-bridge-composer')) return { result: { result: { value: true } } };
      onSent?.();
      throw new Error('click acknowledgement lost');
    };
    await assert.rejects(
      runPageAsk({ call, prompt: 'prompt', targetId: 'A', guard, deadline }),
      /acknowledgement lost/,
    );
    const afterClickCommands = commands;
    await assert.rejects(runPageAsk({ call, prompt: 'prompt', targetId: 'A', guard, deadline }), /关闭.*标签页/);
    assert.equal(commands, afterClickCommands);
    guard.check('B');
    assert.throws(() => guard.check('A'), /关闭.*标签页/);
    deadline.close();
  });
  it('locks the target when composer mutation was sent but click was never sent', async () => {
    const guard = createTargetGuard();
    const deadline = createDeadline(100);
    let clicks = 0;
    const call = async (method, params, onSent) => {
      if (method === 'Runtime.enable') return { result: {} };
      if (params.expression.includes('data-local-bridge-root')) return { result: { result: { value: snap([]) } } };
      if (params.expression.includes('data-local-bridge-composer')) {
        onSent?.();
        throw new Error('composer acknowledgement lost');
      }
      clicks += 1;
      return { result: { result: { value: true } } };
    };
    await assert.rejects(
      runPageAsk({ call, prompt: 'prompt', targetId: 'A', guard, deadline }),
      /composer acknowledgement lost/,
    );
    assert.equal(clicks, 0);
    assert.throws(() => guard.check('A'), /关闭.*标签页/);
    deadline.close();
  });
  it('keeps a completed page reply uncertain until the outer CDP close succeeds', async () => {
    const guard = createTargetGuard();
    const deadline = createDeadline(5_000);
    let reads = 0;
    const call = async (method, params, onSent) => {
      if (method === 'Runtime.enable') return { result: {} };
      if (params.expression.includes('data-local-bridge-root')) {
        reads += 1;
        const value = reads === 1 ? snap([]) : snap([user('u1', 'prompt'), assistant('a1', 'answer')]);
        return { result: { result: { value } } };
      }
      onSent?.();
      return { result: { result: { value: true } } };
    };
    try {
      assert.equal(
        await runPageAsk({
          call,
          prompt: 'prompt',
          targetId: 'A',
          guard,
          deadline,
          waitOptions: {
            sleepFn: async () => {},
            readSnapshotFn: async () => snap([user('u1', 'prompt'), assistant('a1', 'answer')]),
          },
        }),
        'answer',
      );
      assert.equal(guard.isUncertain('A'), true);
    } finally {
      deadline.close();
    }
  });
  it('unlocks the target only after a successful reply and delayed CDP close', async () => {
    const socket = new DelayedCloseSocket();
    const originalSend = socket.send.bind(socket);
    let baselineRead = false;
    socket.send = (data) => {
      originalSend(data);
      const command = JSON.parse(data);
      let value = true;
      if (command.params.expression?.includes('data-local-bridge-root')) {
        value = baselineRead ? snap([user('u1', 'prompt'), assistant('a1', 'answer')]) : snap([]);
        baselineRead = true;
      }
      queueMicrotask(() => socket.event('message', { id: command.id, result: { result: { value } } }));
    };
    const guard = createTargetGuard();
    const deadline = createDeadline(500);
    const promise = runTargetAsk({
      target: { id: 'A', webSocketDebuggerUrl: 'ws://fake' },
      prompt: 'prompt',
      guard,
      deadline,
      connect: (target, work, options) => withCdp(target, work, { ...options, createSocket: () => socket }),
      pageOptions: {
        sleepFn: async () => {},
        readSnapshotFn: async () => snap([user('u1', 'prompt'), assistant('a1', 'answer')]),
      },
    });
    socket.event('open');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.readyState, 2);
    assert.equal(guard.isUncertain('A'), true);
    socket.finishClose();
    assert.equal(await promise, 'answer');
    assert.equal(guard.isUncertain('A'), false);
    deadline.close();
  });
  it('aborts only when the response closes before completion', () => {
    const early = new EventEmitter();
    early.writableEnded = false;
    const deadline = createDeadline(100);
    const unbind = bindClientDisconnect(early, deadline);
    early.emit('close');
    assert.equal(deadline.signal.aborted, true);
    unbind();
    const normal = new EventEmitter();
    normal.writableEnded = true;
    const finished = createDeadline(100);
    bindClientDisconnect(normal, finished);
    normal.emit('close');
    assert.equal(finished.signal.aborted, false);
    finished.close();
  });
  it('keeps A locked after trying B, including when B also fails', () => {
    const guard = createTargetGuard();
    guard.markUncertain('old');
    assert.throws(() => guard.check('old'), /关闭.*标签页/);
    guard.check('new');
    guard.markUncertain('new');
    assert.throws(() => guard.check('old'), /关闭.*标签页/);
    assert.throws(() => guard.check('new'), /关闭.*标签页/);
    guard.clear('new');
    assert.doesNotThrow(() => guard.check('new'));
    assert.throws(() => guard.check('old'), /关闭.*标签页/);
  });
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 0;
  }
  addEventListener(name, fn) {
    this.on(name, fn);
  }
  removeEventListener(name, fn) {
    this.off(name, fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
    if (this.throwSend) throw new Error('send failed');
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  event(name, data) {
    this.emit(name, data === undefined ? {} : { data: JSON.stringify(data) });
  }
}

class DelayedCloseSocket extends FakeSocket {
  close() {
    this.readyState = 2;
  }
  finishClose() {
    this.readyState = 3;
    this.emit('close');
  }
}

class TerminatingSocket extends DelayedCloseSocket {
  terminate() {
    this.finishClose();
  }
}

describe('CDP lifecycle', () => {
  it('kills and awaits its owned child when the native-style worker ignores close', async () => {
    const fixturePath = fileURLToPath(new URL('./ws-worker.fixture.mjs', import.meta.url));
    let socket;
    let closingResolve;
    const closing = new Promise((resolve) => {
      closingResolve = resolve;
    });
    const deadline = createDeadline(1_000);
    const queue = createSerialQueue();
    let nextStarted = false;
    const first = queue.run(() =>
      withCdp({ webSocketDebuggerUrl: 'ws://fixture' }, (call) => call('Runtime.enable'), {
        deadline,
        closeTimeoutMs: 80,
        createSocket: (url) => {
          socket = new ProcessSocket(url, { workerPath: fixturePath });
          const originalClose = socket.close.bind(socket);
          socket.close = () => {
            originalClose();
            closingResolve();
          };
          return socket;
        },
      }),
    );
    const second = queue.run(() => {
      nextStarted = true;
    });
    await closing;
    assert.equal(socket.readyState, 2);
    assert.equal(nextStarted, false);
    assert.equal(socket.child.exitCode, null);
    await assert.rejects(first, /关闭超时/);
    await second;
    assert.equal(socket.readyState, 3);
    assert.equal(nextStarted, true);
    assert.equal(socket.child.exitCode === null && socket.child.signalCode === null, false);
    deadline.close();
  });
  it('uses the command cap separately from overall deadline and clears every command timer', async () => {
    const socket = new FakeSocket();
    const deadline = createDeadline(200);
    const activeTimers = new Set();
    const delays = [];
    const scheduler = {
      setTimeout(fn, ms) {
        delays.push(ms);
        const id = setTimeout(fn, ms);
        activeTimers.add(id);
        return id;
      },
      clearTimeout(id) {
        clearTimeout(id);
        activeTimers.delete(id);
      },
    };
    const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, (call) => call('Runtime.enable'), {
      deadline,
      createSocket: () => socket,
      commandTimeoutMs: 12,
      scheduler,
    });
    socket.event('open');
    await assert.rejects(result, /超时/);
    assert.equal(delays[0], 12);
    assert.equal(activeTimers.size, 0);
    assert.equal(socket.listenerCount('message'), 0);
    deadline.close();
  });
  it('settles two pending commands and clears both timers on socket close', async () => {
    const socket = new FakeSocket();
    const deadline = createDeadline(200);
    const activeTimers = new Set();
    const scheduler = {
      setTimeout(fn, ms) {
        const id = setTimeout(fn, ms);
        activeTimers.add(id);
        return id;
      },
      clearTimeout(id) {
        clearTimeout(id);
        activeTimers.delete(id);
      },
    };
    const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, (call) => Promise.all([call('A'), call('B')]), {
      deadline,
      createSocket: () => socket,
      scheduler,
    });
    socket.event('open');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.length, 2);
    socket.event('close');
    await assert.rejects(result, /断开/);
    assert.equal(activeTimers.size, 0);
    assert.equal(socket.listenerCount('message'), 0);
    socket.event('message', { id: 1, result: {} });
    deadline.close();
  });
  it('waits for asynchronous socket close before returning work and releasing a queue lease', async () => {
    const queue = createSerialQueue();
    const socket = new DelayedCloseSocket();
    const deadline = createDeadline(200);
    let firstSettled = false;
    let secondStarted = false;
    const first = queue.run(() =>
      withCdp(
        { webSocketDebuggerUrl: 'ws://fake' },
        async (call) => {
          await call('Runtime.evaluate', { expression: 'queued click' });
          return 'done';
        },
        { deadline, createSocket: () => socket },
      ),
    );
    first.then(() => {
      firstSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.event('open');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.length, 1);
    socket.event('message', { id: socket.sent[0].id, result: {} });
    const second = queue.run(() => {
      secondStarted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.readyState, 2);
    assert.equal(firstSettled, false);
    assert.equal(secondStarted, false);
    socket.finishClose();
    assert.equal(await first, 'done');
    await second;
    assert.equal(secondStarted, true);
    deadline.close();
  });
  it('terminates a stuck close within its cleanup bound', async () => {
    const socket = new TerminatingSocket();
    const deadline = createDeadline(200);
    const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, async () => 'done', {
      deadline,
      createSocket: () => socket,
      closeTimeoutMs: 12,
    });
    socket.event('open');
    await assert.rejects(result, /关闭超时/);
    assert.equal(socket.readyState, 3);
    assert.equal(socket.listenerCount('close'), 0);
    deadline.close();
  });
  it('does not settle or release a lease when a socket cannot terminate and never closes', async () => {
    const queue = createSerialQueue();
    const socket = new DelayedCloseSocket(); // deliberately has no terminate capability
    const deadline = createDeadline(200);
    let settled = false;
    let nextStarted = false;
    const first = queue.run(() =>
      withCdp({ webSocketDebuggerUrl: 'ws://fake' }, async () => 'done', {
        deadline,
        createSocket: () => socket,
        closeTimeoutMs: 10,
      }),
    );
    first.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    socket.event('open');
    const second = queue.run(() => {
      nextStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
    assert.equal(nextStarted, false);
    socket.finishClose();
    await assert.rejects(first, /关闭|超时/);
    await second;
    deadline.close();
  });
  it('passes the deadline signal into target fetch and expires it', async () => {
    const deadline = createDeadline(20);
    let address;
    const fakeFetch = (url, { signal }) => {
      address = url;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    await assert.rejects(fetchTargets(9222, deadline, fakeFetch), /超时/);
    assert.equal(address, 'http://127.0.0.1:9222/json');
    deadline.close();
  });
  it('handshake times out or closes and settles', async () => {
    const socket = new FakeSocket();
    const deadline = createDeadline(15);
    await assert.rejects(
      withCdp({ webSocketDebuggerUrl: 'ws://fake' }, () => {}, { deadline, createSocket: () => socket }),
      /超时/,
    );
    assert.equal(socket.listenerCount('open'), 0);
  });
  it('handshake error and close both reject without leaving listeners', async () => {
    for (const event of ['error', 'close']) {
      const socket = new FakeSocket();
      const deadline = createDeadline(200);
      const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, () => {}, { deadline, createSocket: () => socket });
      socket.event(event);
      await assert.rejects(result, /调试通道/);
      assert.equal(socket.listenerCount('message'), 0);
      deadline.close();
    }
  });
  it('command timeout clears pending; late response cannot complete it', async () => {
    const socket = new FakeSocket();
    const deadline = createDeadline(25);
    const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, (call) => call('Runtime.enable'), {
      deadline,
      createSocket: () => socket,
    });
    socket.event('open');
    await assert.rejects(result, /超时/);
    socket.event('message', { id: 1, result: {} });
    assert.equal(socket.listenerCount('message'), 0);
  });
  it('send throw, CDP error and close reject active calls', async () => {
    for (const mode of ['throw', 'error', 'socket-error', 'close']) {
      const socket = new FakeSocket();
      socket.throwSend = mode === 'throw';
      const deadline = createDeadline(200);
      const result = withCdp({ webSocketDebuggerUrl: 'ws://fake' }, (call) => call('Runtime.enable'), {
        deadline,
        createSocket: () => socket,
      });
      socket.event('open');
      if (mode === 'error') queueMicrotask(() => socket.event('message', { id: 1, error: { message: 'CDP failed' } }));
      if (mode === 'socket-error') queueMicrotask(() => socket.event('error'));
      if (mode === 'close') queueMicrotask(() => socket.event('close'));
      await assert.rejects(result, /send failed|CDP failed|断开|发生错误/);
      assert.equal(socket.listenerCount('message'), 0);
    }
  });
  it('aborted work cannot send another command', async () => {
    const socket = new FakeSocket();
    const deadline = createDeadline(200);
    const result = withCdp(
      { webSocketDebuggerUrl: 'ws://fake' },
      async (call) => {
        deadline.abort();
        await call('Runtime.evaluate');
      },
      { deadline, createSocket: () => socket },
    );
    socket.event('open');
    await assert.rejects(result, /客户端已断开/);
    assert.equal(socket.sent.length, 0);
    deadline.close();
  });
});
