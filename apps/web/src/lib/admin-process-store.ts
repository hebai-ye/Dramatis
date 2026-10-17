import type { AdminArtifact, AdminTurnObservation, ConversationId, MessageId, RoomId } from '@dramatis/core';
import type { AdminSceneEffect, AdminSceneTarget } from './admin-scene-effect';

export interface AdminProcessScope {
  db: object;
  accountKey: string;
  roomId: RoomId;
  conversationId: ConversationId;
}
export type AdminRunPhase =
  | 'saving-input'
  | 'preparing'
  | 'waiting-model'
  | 'receiving-reasoning'
  | 'writing'
  | 'executing'
  | 'waiting-next-model'
  | 'saving-output'
  | 'saved'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'partial'
  | 'uncertain'
  | 'saved-read-failed'
  | 'saved-accounting-failed';
export interface AdminRunIssue {
  kind: 'error' | 'uncertain' | 'read' | 'accounting';
  text: string;
}
export interface AdminRunPatch {
  updatedAt?: number;
  phase?: AdminRunPhase;
  endedAt?: number;
  unsaved?: { text: string; artifacts: readonly AdminArtifact[] } | null;
  issue?: AdminRunIssue | null;
}
export interface AdminRunSnapshot {
  scope: AdminProcessScope;
  runId: string;
  messageId: MessageId | null;
  phase: AdminRunPhase;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
  entries: readonly { key: string; sequence: number; receivedAt: number; event: AdminTurnObservation }[];
  unsaved: NonNullable<AdminRunPatch['unsaved']> | null;
  issue: AdminRunIssue | null;
  sceneEffects: readonly AdminSceneEffect[];
  sceneTargets: Readonly<Record<string, AdminSceneTarget>>;
  expanded: Readonly<Record<string, boolean>>;
}
type Lookup = { runId: string } | { messageId: MessageId };
type Bucket = {
  scope: AdminProcessScope;
  runs: Map<string, AdminRunSnapshot>;
  active: string | null;
  left: boolean;
  listeners: Set<() => void>;
};
export const sameAdminScope = (a: AdminProcessScope | null, b: AdminProcessScope | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.db === b.db &&
    a.accountKey === b.accountKey &&
    a.roomId === b.roomId &&
    a.conversationId === b.conversationId);

export function createAdminProcessStore() {
  const databases = new WeakMap<object, Map<string, Bucket>>();
  const key = (scope: AdminProcessScope) => JSON.stringify([scope.accountKey, scope.roomId, scope.conversationId]);
  function bucket(scope: AdminProcessScope, create = false) {
    let map = databases.get(scope.db);
    if (!map && create) {
      map = new Map();
      databases.set(scope.db, map);
    }
    let value = map?.get(key(scope));
    if (!value && create) {
      value = { scope, runs: new Map(), active: null, left: false, listeners: new Set() };
      map?.set(key(scope), value);
    }
    return value;
  }
  function change(
    scope: AdminProcessScope,
    runId: string,
    update: (run: AdminRunSnapshot) => AdminRunSnapshot,
    requireActive = true,
  ) {
    const b = bucket(scope),
      run = b?.runs.get(runId);
    if (!b || !run || (requireActive && (b.active !== runId || b.left))) return;
    const next = update(run);
    if (next === run) return;
    b.runs.set(runId, next);
    for (const listener of b.listeners) listener();
  }
  return {
    begin(scope: AdminProcessScope, runId: string, at: number) {
      const b = bucket(scope, true);
      if (!b) return;
      b.active = runId;
      b.left = false;
      b.runs.set(runId, {
        scope,
        runId,
        messageId: null,
        phase: 'saving-input',
        startedAt: at,
        endedAt: null,
        updatedAt: at,
        entries: [],
        sceneEffects: [],
        sceneTargets: {},
        unsaved: null,
        issue: null,
        expanded: {},
      });
      for (const listener of b.listeners) listener();
    },
    observe(scope: AdminProcessScope, runId: string, event: AdminTurnObservation, at: number) {
      change(scope, runId, (run) => {
        const tool =
          'toolIndex' in event ? `tool:${event.requestIndex}:${event.toolIndex}` : `request:${event.requestIndex}`;
        const eventKey = `${tool}:${event.type}`;
        if (event.type !== 'reasoning' && run.entries.some((e) => e.key === eventKey)) return run;
        const entries = [...run.entries],
          last = entries.at(-1);
        if (event.type === 'reasoning' && event.delta === '') return run;
        if (
          event.type === 'reasoning' &&
          last?.event.type === 'reasoning' &&
          last.event.requestIndex === event.requestIndex
        ) {
          entries[entries.length - 1] = {
            ...last,
            receivedAt: at,
            event: { ...event, delta: last.event.delta + event.delta },
          };
        } else entries.push({ key: eventKey, sequence: (last?.sequence ?? 0) + 1, receivedAt: at, event });
        const phase =
          event.type === 'reasoning'
            ? 'receiving-reasoning'
            : event.type === 'request-start'
              ? event.requestIndex === 0
                ? 'waiting-model'
                : 'waiting-next-model'
              : event.type === 'tool-start'
                ? 'executing'
                : event.type === 'tool-end'
                  ? 'waiting-next-model'
                  : run.phase;
        return { ...run, phase, entries, updatedAt: at };
      });
    },
    update(scope: AdminProcessScope, runId: string, patch: AdminRunPatch) {
      change(scope, runId, (run) => ({ ...run, ...patch }));
    },
    settle(scope: AdminProcessScope, runId: string, patch: AdminRunPatch) {
      change(scope, runId, (run) => ({ ...run, ...patch }), false);
    },
    resume(scope: AdminProcessScope, runId: string, at: number) {
      const b = bucket(scope),
        run = b?.runs.get(runId);
      if (!b || !run) return false;
      b.active = runId;
      b.left = false;
      b.runs.set(runId, { ...run, endedAt: null, updatedAt: at });
      for (const listener of b.listeners) listener();
      return true;
    },
    bindMessage(scope: AdminProcessScope, runId: string, messageId: MessageId) {
      change(scope, runId, (run) => ({ ...run, messageId }), false);
    },
    bindSceneTarget(scope: AdminProcessScope, runId: string, artifactId: string, target: AdminSceneTarget) {
      change(scope, runId, (run) => ({ ...run, sceneTargets: { ...run.sceneTargets, [artifactId]: target } }), false);
    },
    sceneEffect(scope: AdminProcessScope, runId: string, effect: AdminSceneEffect) {
      change(
        scope,
        runId,
        (run) => ({
          ...run,
          sceneEffects: [...run.sceneEffects.filter((e) => e.target.sceneId !== effect.target.sceneId), effect],
        }),
        false,
      );
    },
    setExpanded(scope: AdminProcessScope, runId: string, name: string, open: boolean) {
      change(
        scope,
        runId,
        (run) => (run.expanded[name] === open ? run : { ...run, expanded: { ...run.expanded, [name]: open } }),
        false,
      );
    },
    get(scope: AdminProcessScope, lookup: Lookup): AdminRunSnapshot | null {
      const b = bucket(scope);
      if ('runId' in lookup) return b?.runs.get(lookup.runId) ?? null;
      return [...(b?.runs.values() ?? [])].find((run) => run.messageId === lookup.messageId) ?? null;
    },
    subscribe(scope: AdminProcessScope, listener: () => void) {
      const b = bucket(scope, true);
      b?.listeners.add(listener);
      return () => {
        b?.listeners.delete(listener);
      };
    },
    leave(scope: AdminProcessScope) {
      const b = bucket(scope);
      if (!b) return;
      b.left = true;
      for (const [id, run] of b.runs)
        b.runs.set(id, { ...run, entries: run.entries.filter((e) => e.event.type !== 'reasoning') });
      for (const listener of b.listeners) listener();
    },
    clearAccount(db: object, accountKey: string) {
      const map = databases.get(db);
      if (!map) return;
      for (const [k, b] of map)
        if (b.scope.accountKey === accountKey) {
          map.delete(k);
          for (const listener of b.listeners) listener();
        }
    },
  };
}
export type AdminProcessStore = ReturnType<typeof createAdminProcessStore>;
export const adminProcessStore = createAdminProcessStore();
