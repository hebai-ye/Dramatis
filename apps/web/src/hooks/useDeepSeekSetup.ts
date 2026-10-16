import { useCallback, useEffect, useRef, useState } from 'react';
import { deepseekSetupState } from '../lib/deepseek-setup';
import type { ProvidersApi } from '../lib/providers';

export function useDeepSeekSetup({
  accountKey,
  providers,
  blocked,
}: {
  accountKey: string;
  providers: ProvidersApi;
  blocked: boolean;
}) {
  const state = deepseekSetupState(providers);
  const owner = JSON.stringify([accountKey, providers.active?.id ?? null, providers.keyMode]);
  const dismissed = useRef(new Set<string>());
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (state === 'configured') {
      dismissed.current.delete(owner);
      if (blocked) setRequested(false);
    } else if (state !== 'waiting' && !dismissed.current.has(owner)) setRequested(true);
  }, [state, owner, blocked]);
  const dismiss = useCallback(() => {
    dismissed.current.add(owner);
    setRequested(false);
  }, [owner]);
  const requestOpen = useCallback(() => setRequested(true), []);
  return { open: requested && !blocked, state, requestOpen, dismiss };
}
