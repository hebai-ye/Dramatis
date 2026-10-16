import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
export interface SubmitOutcome {
  status: 'accepted' | 'rejected' | 'uncertain';
  reason?: string;
}
// biome-ignore lint/suspicious/noConfusingVoidType: older host fixtures may decline without a return; only explicit accepted clears drafts.
export type ChatSend = (text: string) => void | SubmitOutcome | Promise<SubmitOutcome>;
interface Draft {
  text: string;
  revision: number;
  pending: boolean;
  notice: string | null;
}
const DraftContext = createContext<Map<string, Draft> | null>(null);
export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const store = useRef(new Map<string, Draft>());
  return <DraftContext.Provider value={store.current}>{children}</DraftContext.Provider>;
}
/** Drafts live in this App's memory only; switching kind does not transfer or erase them. */
export function useChatDraft(scope: string, send: ChatSend) {
  const shared = useContext(DraftContext);
  const local = useRef(new Map<string, Draft>());
  const store = shared instanceof Map ? shared : local.current;
  const [, invalidate] = useState(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  let draft = store.get(scope);
  if (!draft) {
    draft = { text: '', revision: 0, pending: false, notice: null };
    store.set(scope, draft);
  }
  const current = draft;
  const refresh = () => {
    if (mounted.current && scopeRef.current === scope) invalidate((value) => value + 1);
  };
  const change = (text: string) => {
    current.text = text;
    current.revision++;
    current.notice = null;
    refresh();
  };
  const submit = async () => {
    const text = current.text.trim();
    if (!text || current.pending) return;
    const revision = current.revision;
    current.pending = true;
    current.notice = null;
    refresh();
    try {
      const result = await send(text);
      if (result?.status === 'accepted') {
        if (current.revision === revision) {
          current.text = '';
          current.revision++;
        }
      } else if (current.revision === revision) current.notice = result?.reason ?? '尚未发送，输入已保留。';
    } catch (error) {
      if (current.revision === revision)
        current.notice = `发送结果待核对，输入已保留；请先检查消息记录。${error instanceof Error ? error.message : String(error)}`;
    } finally {
      current.pending = false;
      refresh();
    }
  };
  return { input: current.text, setInput: change, submit, notice: current.notice, pending: current.pending };
}
