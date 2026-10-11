/** Test-only child: responds to commands but intentionally ignores graceful close. */
process.on('message', (message) => {
  if (message?.kind === 'connect') process.send({ kind: 'open' });
  if (message?.kind === 'send') {
    const command = JSON.parse(message.data);
    process.send({ kind: 'message', data: JSON.stringify({ id: command.id, result: {} }) });
  }
});
process.on('disconnect', () => process.exit(0));
