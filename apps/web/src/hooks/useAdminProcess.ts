import type { MessageId } from '@dramatis/core';
import { useCallback, useSyncExternalStore } from 'react';
import { type AdminProcessScope, adminProcessStore } from '../lib/admin-process-store';

export function useAdminProcess(scope: AdminProcessScope | null, lookup: { runId: string } | { messageId: MessageId }) {
  const id = 'runId' in lookup ? lookup.runId : lookup.messageId;
  const message = 'messageId' in lookup;
  const subscribe = useCallback(
    (listener: () => void) => (scope ? adminProcessStore.subscribe(scope, listener) : () => {}),
    [scope],
  );
  const get = useCallback(
    () => (scope ? adminProcessStore.get(scope, message ? { messageId: id as MessageId } : { runId: id }) : null),
    [scope, id, message],
  );
  return useSyncExternalStore(subscribe, get, get);
}
