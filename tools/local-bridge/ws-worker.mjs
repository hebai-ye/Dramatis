/** The only process that owns a native WebSocket. IPC payloads are never logged. */
let socket;
let connecting = false;

function report(kind, data) {
  if (process.connected) process.send(data === undefined ? { kind } : { kind, data });
}

process.on('message', (message) => {
  if (message?.kind === 'connect') {
    if (connecting) return;
    connecting = true;
    try {
      socket = new WebSocket(message.url);
      socket.addEventListener('open', () => report('open'));
      socket.addEventListener('message', (event) => report('message', String(event.data)));
      socket.addEventListener('error', () => report('error'));
      socket.addEventListener('close', () => process.exit(0));
    } catch {
      report('error');
      process.exit(1);
    }
  } else if (message?.kind === 'send') {
    try {
      socket?.send(message.data);
    } catch {
      report('error');
    }
  } else if (message?.kind === 'close') {
    try {
      if (socket) socket.close();
      else process.exit(0);
    } catch {
      process.exit(0);
    }
  }
});

process.on('disconnect', () => process.exit(0));
