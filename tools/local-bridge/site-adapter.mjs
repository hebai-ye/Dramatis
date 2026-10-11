/** A deliberately explicit page contract. No site's private DOM is inferred. */
export const UNSUPPORTED_HINT = '自动识别未验证，请使用手动回填。';

function validate(snapshot) {
  if (snapshot?.supported !== true) throw new Error(`${snapshot?.reason ?? '页面不符合桥接契约'}。${UNSUPPORTED_HINT}`);
  if (typeof snapshot.generating !== 'boolean') throw new Error(`无法确认页面生成状态。${UNSUPPORTED_HINT}`);
  if (!Array.isArray(snapshot.messages)) throw new Error(`无法确认消息列表。${UNSUPPORTED_HINT}`);
  const ids = new Set();
  for (const message of snapshot.messages) {
    if (typeof message.id !== 'string' || message.id.trim() === '' || ids.has(message.id))
      throw new Error(`消息身份缺失或重复。${UNSUPPORTED_HINT}`);
    if (
      !['user', 'assistant'].includes(message.role) ||
      typeof message.body !== 'string' ||
      typeof message.terminal !== 'boolean'
    )
      throw new Error(`角色、正文或明确终态缺失。${UNSUPPORTED_HINT}`);
    ids.add(message.id);
  }
  return snapshot;
}

export function captureBaseline(snapshot) {
  const valid = validate(snapshot);
  if (valid.generating) throw new Error('网页仍在生成上一轮回复，请等它结束后再发送。');
  if (valid.messages.some((message) => message.role === 'assistant' && !message.terminal))
    throw new Error(`上一轮回复终态无法确认。${UNSUPPORTED_HINT}`);
  const baseline = new Map(
    valid.messages.map((message, index) => [message.id, { role: message.role, body: message.body, index }]),
  );
  baseline.seen = new Map(
    valid.messages.map((message, index) => [message.id, { role: message.role, index, body: message.body }]),
  );
  return baseline;
}

export function observeReply(baseline, snapshot, prompt) {
  const valid = validate(snapshot);
  const currentIds = new Set(valid.messages.map((message) => message.id));
  for (const id of baseline.seen.keys()) {
    if (!currentIds.has(id)) throw new Error(`消息列表截断或身份消失。${UNSUPPORTED_HINT}`);
  }
  for (const [index, message] of valid.messages.entries()) {
    const old = baseline.get(message.id);
    if (old && (old.role !== message.role || old.body !== message.body || old.index !== index)) {
      throw new Error(`消息身份被复用或基线发生变化。${UNSUPPORTED_HINT}`);
    }
    const seen = baseline.seen.get(message.id);
    if (
      seen &&
      (seen.role !== message.role || seen.index !== index || (seen.role === 'user' && seen.body !== message.body))
    )
      throw new Error(`消息身份被复用或顺序变化。${UNSUPPORTED_HINT}`);
    baseline.seen.set(message.id, { role: message.role, index, body: message.body });
  }
  const newMessages = valid.messages.filter((message) => !baseline.has(message.id));
  const matches = newMessages.filter((message) => message.role === 'user' && message.body === prompt);
  if (matches.length === 0) return { done: false };
  if (
    matches.length !== 1 ||
    newMessages[0] !== matches[0] ||
    newMessages.length > 2 ||
    (newMessages[1] && newMessages[1].role !== 'assistant')
  )
    throw new Error(`本次回复归属存在交错或歧义。${UNSUPPORTED_HINT}`);
  const reply = newMessages[1];
  if (!reply || reply.body.trim() === '' || !reply.terminal || valid.generating) return { done: false };
  return { done: true, id: reply.id, text: reply.body };
}

export async function readSnapshot(call) {
  const expression = `(() => {
    const root = document.querySelector('[data-local-bridge-root]');
    if (!root) return { supported: false, reason: '页面没有经验证的桥接契约' };
    const state = root.getAttribute('data-generating');
    if (state !== 'true' && state !== 'false') return { supported: false, reason: '生成状态未确认' };
    const messages = [...root.querySelectorAll('[data-local-bridge-message]')].map((node) => {
      if (node.querySelector('[data-thinking]') || node.getAttribute('data-thinking') === 'true') return null;
      const body = node.querySelector('[data-local-bridge-body]');
      const terminal = node.getAttribute('data-terminal');
      return { id: node.getAttribute('data-message-id'), role: node.getAttribute('data-role'), body: body?.innerText, terminal: terminal === 'true' ? true : terminal === 'false' ? false : null };
    });
    if (messages.includes(null)) return { supported: false, reason: '思考区和正文无法分开' };
    return { supported: true, generating: state === 'true', messages };
  })()`;
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.error || result.result?.exceptionDetails) throw new Error(`读取页面失败。${UNSUPPORTED_HINT}`);
  return result.result?.result?.value;
}

export async function fillAndClick(call, prompt, onMutationIssued) {
  const fill = `(() => {
    const box = document.querySelector('[data-local-bridge-composer]');
    if (!(box instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(box, ${JSON.stringify(prompt)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    return true;
  })()`;
  const first = await call('Runtime.evaluate', { expression: fill, returnByValue: true }, onMutationIssued);
  if (first.result?.result?.value !== true) throw new Error(`输入框不符合桥接契约。${UNSUPPORTED_HINT}`);
  const click = `(() => {
    const button = document.querySelector('[data-local-bridge-send]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`;
  // Either mutation may have happened when its acknowledgement is lost.
  const second = await call('Runtime.evaluate', { expression: click, returnByValue: true }, onMutationIssued);
  if (second.result?.result?.value !== true) throw new Error(`发送按钮不符合桥接契约。${UNSUPPORTED_HINT}`);
}
