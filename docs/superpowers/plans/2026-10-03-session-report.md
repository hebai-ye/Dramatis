# B07 / A13 web session report

## B07 deterministic fixture prepared

`apps/web/src/components/SessionHarness.test.tsx` drives the real `useSession` with a real in-memory `Repository`. Its controlled React render harness exposes the hook's public `world`, `scene`, and `messages` values. Repository Promise barriers capture a completed A snapshot or persisted A write, then let B or an append finish before releasing the older operation. No timer or source-text inspection determines ordering.

Prepared cases: A-open held → B-open complete → release A (UI and `lastRoomId` remain B); stale reload held → append m2 → release reload (m2 remains); A message update and A scene update held after persistence → open B → release (UI remains B, A storage write remains); old A-open held → B-open → new A-open with a newer title → release old A (new A snapshot remains). Each case releases and awaits its held operation in `finally`.

**Red evidence:** root's centralized `pnpm --filter @dramatis/web test -- src/components/SessionHarness.test.tsx` run in `logs/session-fixed-sequence-red.log` failed all five cases. The assertions observed A replacing B after a delayed open, reload dropping m2, delayed message and scene updates restoring A, and an old A snapshot replacing the newer A title. These are observed UI failures. The original hard UI assertions stopped each case before its final `lastRoomId` assertion, so that log does **not** establish a metadata failure. The fixture now uses independent soft assertions for final UI, storage, and metadata effects; this revision has not been run by the subtask. Root also reported a passing quality fake run (37/37) and typecheck before this fixture revision. Production green and final typecheck remain root's centralized gate.

## B07 production implementation after root red confirmation

`session.ts` now routes every snapshot installation through `conditionalCommit`. A room/conversation selection begins a new `selectionEpoch`; every accepted snapshot commit advances `snapshotRevision`. A completion needs the captured epoch and room. Explicit room selection and initial restoration may install a different room, but still require their selection token and captured read revision. The initial restoration also retains its effect cancellation guard.

`readSnapshot` captures the visible revision before reading. Background reload and `refreshAll` discard a superseded result; full reads following persistence retry within the same scope when a local commit advanced the revision. They stop when selection changes. After the follow-up review, each captured scope also records the invocation revision: `commitPatch` uses its field/collection delta path only when that revision still matches. An intervening UI commit instead triggers an awaited guarded storage reread; it never infers new entities or nested-field changes from a superseded response. Room-reference and scene-cast string arrays retain their existing set-delta fast path without adding a new recursive merge layer.

`lastRoomId` has one promise queue and checks its selection token immediately before starting a write. A write already in progress finishes first; the newer room write follows it. Room and conversation selections enqueue the current room, so a same-room conversation selection cannot invalidate the only pending room metadata write without scheduling its replacement. Queue failures reach callers, while the queue tail recovers for later tasks.

### Static write-site inventory

| Paths | Production handling |
| --- | --- |
| Initial restore | Captured epoch/revision and effect cancellation through `conditionalCommit`. |
| `openWorld`, `createWorld` | Begin selection; revision-guarded full read; scoped queued metadata. |
| `reloadWorld`, `refreshAll` | Capture scope at invocation; discard a superseded read. |
| `startConversation` | Begin same-room selection; scoped metadata; revision-guarded full read after persistence. |
| `openConversation`, newly created `openSideConversation` | Begin same-room selection; changed room/presence/conversation fields merge into latest; scoped room metadata. |
| `archiveConversation`, `deleteConversation`, `deleteArchivedConversation`, `deletePersona` | Capture scope before persistence; full read retries revision changes; completion cannot restore the old selection. |
| `deleteWorld` | Clear current UI and enqueue null only while the captured selection still matches; clearing advances epoch. |
| `renameWorld`, `setBudget` | Scoped changed-room-field merge. |
| `updateConversation`, `renameConversation` | Scoped changed-conversation-field merge. |
| `updateScene`, `startNewScene`, `setWorldScene` | Scoped scene/conversation/presence delta merge. A10 explicit target and optional expected room stay unchanged. |
| `addInstance`, `removeInstance`, `updateInstance`, `setRelationship`, `revertAffectChange`, `setPresence` | Scoped room/cast/instance/card delta merge. |
| `updateMessage`, `deleteMessage` | Scoped message delta merge. |
| `updateMemory`, `deleteMemory`, `markRecalled` | Scoped memory delta merge. |
| `setPersona`, `savePersona` | Scoped room/conversation/persona delta merge. |
| `attachWorldBook`, `detachWorldBook`, `saveCard`, `saveWorldBook`, `deleteWorldBook` | Scope captured before persistence; latest room/library-entity delta merge. |
| `revertTurn`, `rewriteTurn` | Existing transaction persistence unchanged; returned message/memory/instance deltas merge in captured scope. |
| `adoptArtifact`, `discardArtifact`, `revokeArtifact` | Returned message/artifact changes merge in captured scope, including conflict branches. |
| `reverseArtifact` | Rechecks captured epoch before drafting append and before displaying a later error. |
| `appendMessages` | Existing per-session serialized append and execution-time snapshot reread retained; invocation scope also guards the UI commit, including ABA. Its fallback message reread has a revision guard and scoped refresh retry. |

Scope exceptions are deliberate: repository work targeting the captured old room may still finish in storage; global world summaries, library, and persona lists are shared resources and continue refreshing. `deleteCard` only updates the global library and never installs a room snapshot. `setWorldScene` still validates the explicit main conversation against the captured room in storage, and a later UI selection change does not redirect its persistence to another room. Its UI completion cannot switch back or modify a later ABA selection.

**The epoch and snapshot revision are UI versions, not repository compare-and-swap.** These changes do not prevent cross-tab, sync, or same-entity persistence races from writing captured storage values. Repository CAS and atomic storage correctness remain the core/storage dependency; this report makes no claim that those races are solved.

### Prepared verification, not executed by this subtask

The original five real-hook/repository cases remain, now with independent final soft assertions. Five more deterministic cases cover: an already running A metadata write followed by B; obsolete queued B metadata across A→B→A; a delayed message edit preserving a subsequent append; a delayed scene update rejected after ABA; and a conversation-archive full read retrying after an intervening append. Promise barriers observe completed repository work or an actual snapshot setter; no timeout establishes ordering. Held operations are released and awaited in `finally`.

No test, typecheck, lint, build, smoke, commit, or push was run by this implementation subtask, following the user's centralized-gate instruction. At the initial implementation handoff, the earlier root red log was the only executed five-case evidence. Root subsequently reported a 311-test/typecheck pass and then the follow-up review red run documented below; the post-review production changes still await a new centralized green gate. Prepared root inputs: `src/components/SessionHarness.test.tsx`, `src/components/admin-session.test.tsx`, `src/components/DatabaseRecovery.test.tsx`, and `src/components/ImportRecoveryNotice.test.tsx`.

## Follow-up static review: three uncovered B07 sequences

Root reported the prior web gate passed 311 tests and typecheck before these follow-up fixtures. That pass did not cover the following independently identified sequences. The implementation subtask has not run any new validation.

Four additional real-hook/repository Promise-barrier fixtures are now prepared in `SessionHarness.test.tsx`: visible C1 → C2 `saveRoom` persisted but held → reselect C1 → release C2 (assert both visible and stored active conversation are C1); visible A → B full read held → reselect A → release B (UI and metadata remain A, a comparison case for existing world selection behavior); content edit persisted but returned cloned Message held → discard artifact completes → release edit (UI and storage artifact remain discarded); add X completely persisted but `saveRoom` return held → reload exposes X → remove X completes → release add (UI instance, room IDs, scene cast, and storage all keep X removed). The file now has 14 cases. All held operation promises are released and awaited in `finally`.

Static causes: `openConversation` returns before advancing the selection epoch when the requested ID is still visible, so it fails to cancel an older pending choice. `mergeChangedFields` currently treats clone references as changes and can copy an unrelated older nested value. `mergeChangedCollection` cannot distinguish a genuinely unseen new entity from one subsequently loaded and deleted, and the string-reference delta can similarly re-add a deleted ID.

**Root's centralized red evidence is now recorded in `logs/session-review-red.log`: 3 failed, 1 passed, 10 skipped.** The C1 reselect case failed both UI and stored active conversation; the cloned edit changed the visible artifact back to pending; the old add resurrected the visible instance, room ID, and scene cast even though the corresponding storage assertions remained correct. The same-world reselect comparison passed. These are real repository/hook observations, not conclusions inferred from source.

Production follow-up now removes only the same-conversation early return, so the final choice advances epoch and writes the requested active conversation even when it is still visible. The unchanged `openWorld` path continues beginning a selection for same-world requests; `openSideConversation`'s existing-side branch delegates to the corrected conversation path.

`SnapshotScope` now captures the invocation `snapshotRevision` in both `captureScope` and `beginSelection`. `commitPatch` first rejects an outdated room/selection token. If an accepted intervening snapshot commit changed the invocation revision, it awaits the existing same-scope `readSnapshot` path: the read captures the current revision, checks scope again after completion, and retries a changed read revision. Otherwise its synchronous delta commit explicitly checks the invocation revision before installation. It does not update scope revision or perform a second commit after its own accepted installation, so an ordinary single-completion operation does not cause an extra reread of its own write.

All 33 `commitPatch` call sites now await the returned completion, including selection paths that check the returned boolean before metadata writes, artifact conflict branches, memory/turn methods, instance/cast changes, and library-entity completions. The generic helpers remain unchanged: late completions no longer enter those helpers after a newer visible edit or deletion. No deep-comparison, tombstone registry, repository change, public SessionApi change, or additional storage/CAS mechanism was introduced.

This implementation subtask did not run test/typecheck/lint/build/smoke after the follow-up changes and does not claim a passing fix. Root should first rerun the four review sequences (`reselecting|discarded artifact|instance that was loaded`), then the complete 14-case SessionHarness and existing admin-session regression, followed by web typecheck. Independent incremental review is also pending root's green gate.

## Incremental review: mutation reread can restore an old stored selection

Root's incremental reviewer marked the prior three findings addressed and identified a fourth boundary. The new 15th SessionHarness fixture controls two persisted `saveRoom` completions: C1 visible → opening C2 persists and holds → rename captures the still-visible C1 in the same epoch, persists a new title with C1, and holds → release open so UI commits C2 → release rename so its revision-conflict reread sees stored C1. The expected UI retains the latest committed C2 while showing the renamed title and both complete conversation records. Storage is explicitly observed still containing C1 and the new title, documenting that this task does not solve the captured room persistence/CAS race.

Root's centralized red run is recorded in `logs/session-reread-selection-red.log`: 1 failed, 14 skipped. Only the final UI conversation assertion failed; the renamed title, both complete conversation records, and explicit stored C1/title assertions passed. Both barriers are released and both operations are awaited in `finally`; no timing sleep determines ordering.

The fourth-finding production follow-up initially added a default-off `preserveConversation` option to the existing guarded full-room read. Only `commitPatch`'s ordinary mutation revision-conflict branch enabled it; explicit `openConversation` and newly created `openSideConversation` commits explicitly opted out. Inside the revision-guarded commit, the latest committed `activeConversationId` was retained if that conversation was present in the loaded full collection and was neither deleted nor archived. This changed only the installed UI room selection; the newly loaded title and every full room collection remained available. The boolean policy was subsequently replaced by the explicit-target policy documented in the next section. The repository call remains the unfiltered `loadRoom(scope.roomId)`, preserving complete-room `locateTurn`/`bundleOf` data; no storage write or CAS repair is added.

No test/typecheck/lint/build/smoke was run by this subtask after the fourth-finding change. Root should rerun `latest committed conversation`, then all 15 SessionHarness cases and relevant web regression/type/build gates in its centralized window. A passing-fix claim and incremental independent review remain pending.

## Final incremental review: explicit navigation needs a target, not a boolean opt-out

Root reported the 15th case and 28 related cases passed, with types passing, after the fourth-finding change. The next independent review found that a completed C1 append can advance revision before the pending C2 open commits. The current boolean opt-out makes its conflict reread accept the older C1 stored by the concurrent rename, so the explicit C2 choice is never installed. Newly created side-conversation selection uses the same path.

Two further fixed Promise fixtures are prepared, bringing SessionHarness to 17 cases. They extend the dual persisted-room barriers with a completed C1 append before releasing the open. One targets explicit C2; the other opens a newly created side conversation. Both check the requested conversation immediately after the open completes and after the rename finishes, while preserving the renamed title, complete-room C1 message bundle, and intended conversation record. The stored active C1 is still explicitly asserted to document the out-of-scope persistence/CAS race. All held operations are released and awaited in `finally`.

Root's centralized red evidence is now recorded in `logs/session-explicit-target-red.log`: 2 failed, 15 skipped. Both the explicit C2 open and the new side open failed their immediate and final requested-selection assertions; the side case also still displayed kind `main`. The title, complete C1 message bundle, conversation records, and explicit old-active storage boundary assertions passed.

The bounded production correction now replaces the boolean opt-out with `ConversationReadPolicy`: an explicit `{ kind: 'target', id }` request, `{ kind: 'latest' }` for ordinary mutation conflicts, or an omitted policy for the repository's loaded selection. Every selected ID must still exist in the complete loaded collection and be neither deleted nor archived before the UI room's active ID is overlaid. `commitPatch` accepts the explicit target ID instead of a boolean, and `openConversation` / newly created `openSideConversation` pass their requested IDs. The existing `startConversation` full read also receives its newly planned conversation ID as the same explicit-selection policy; this single-call-site extension addresses the same family found in the static write-site inventory. Ordinary mutation conflicts retain the latest valid committed selection. Background reload and archive/delete reads still omit the policy, preserving their loaded-selection behavior.

The full unfiltered `loadRoom(scope.roomId)` call and every complete world collection remain unchanged. This is a UI selection overlay after token/revision checks, not a persistence/CAS repair. No additional merge layer, public SessionApi change, or repository writes were introduced. No tests/typecheck/lint/build/smoke were run by this subtask after the explicit-target change. Suggested root gate is the two-case filter `target when an append advances revision`, then the full 17-case SessionHarness and centrally selected web/regression/type/lint/build gates; passing-fix and final independent-review conclusions remain pending.

## A13 web implemented; core safety remains pending

Read-only inspection of `packages/core/src/storage/archive.ts` still finds `InterruptedImportRecovery` has only `{ rooms: RoomId[], stillPending: number }`. `recoverInterruptedImports` checks merely that `roomId` is a string before parsing `startedAt`; `rollbackImport` may delete the room before iterating unvalidated `cardIds` and `worldBookIds`. A malformed marker can therefore partially modify storage and then throw. The core contract has no structured warning field, per-marker isolation, or guarantee that an invalid marker cannot delete an existing world. Core files were not changed.

Web now extends `BootReport` with `importRecoveryWarnings: { code, message, markerId? }[]` and consumes an optional, actually returned `warnings` field. Extra raw fields are dropped and malformed warning shapes become neutral readable notices. The current successful legacy return produces no fabricated warnings. Completed rollback count remains the returned `rooms.length`; skipped/pending markers are not counted. If recovery throws, the completed count is unavailable and the report records no reported rollbacks; this does not mean no partial rollback occurred.

The recovery catch does not retry the unsafe recovery call. It continues booting the opened repository and shows: “导入恢复检查未完成。已继续加载可读取的本机数据，请检查现有世界和导入记录。” It exposes neither the caught marker/error contents nor a promise that worlds were preserved. `ImportRecoveryNotice`, wired into `App.tsx` below navigation, wraps text, allows vertical scrolling on a small screen, and uses an accessible status region. Marker IDs/codes are diagnostic fields, not displayed user content. Core-authored future warning messages must themselves be suitable for display.

Prepared, unrun web cases verify a recovery exception continues boot without retry/raw-error exposure; a structured result reaches `BootReport`; notices display warnings and only returned completed rollback counts; malformed warning data does not reveal extra raw fields. The tests simulate the optional warning contract and **do not** establish that real malformed import markers preserve worlds.

Core handoff remains: validate every marker field and legitimate scope before any deletion; isolate each marker; skip invalid markers without deleting an existing room; preserve other markers/worlds after one failure; return structured warnings with safe display messages and accurate successful rollback counts. Real bad-marker world-retention acceptance is blocked on that core change and must be run against the real recovery implementation when it lands.

## Final read-policy coverage: ordinary full reads and archived review

Root reported the preceding full web gate passed 319 tests (with core 878 and sync 88) before these additional fixtures. Static independent review then identified ordinary full reads still using stored selection in `deletePersona` and the append fallback after a superseded `listMessages` result; conversation archive/delete completion reads have the same boundary. It also confirmed archived explicit review is a legitimate user path (`App.tsx` opens it through `openConversation`), so rejecting all archived targets in the read policy can leave that view during a revision conflict.

Nine additional cases bring SessionHarness from 18 to 27 cases. A minimal shared setup reconstructs the already demonstrated case-15 boundary using real repository writes: UI committed C2 while a previously captured C1 room write remains stored. It asserts that boundary before exercising persona deletion, a delayed persisted append followed by a delayed actual message reread and two intervening UI commits, an archived explicit open delayed until a rename commits, an ordinary mutation conflict while reviewing an archived conversation, and four table-driven archive/delete completion paths. The table covers archive-other, archive-current, delete-other, and delete-archived-other; it holds an actual full-room result and advances revision before release so the choice must be evaluated against the latest accepted snapshot. The final case begins an archive while UI still shows C1 and a persisted C2 open is held; that open commits C2 while the archive's full read is held. It expects archive completion to select C1, proving that exclusion must be decided from the latest active ID inside the conditional updater rather than from the invocation's C1 snapshot. All operation barriers release and await pending operations in `finally`, without sleeps or source inspection establishing ordering.

The fixtures retain hard expected active IDs, complete ordinary/archived collection membership, persisted message content and deletion/archive effects, and the old stored C1 active ID. This preserves the UI/storage distinction rather than silently repairing repository persistence.

**Root's centralized red evidence:** `logs/session-policy-final-red.log` recorded 7 failed and 20 passed across all 27 cases. Persona deletion, superseded append fallback, archived explicit target, archived ordinary mutation, archive-other, delete-other, and delete-archived-other failed their selection assertions. Archive-current and the newly selected archive exclusion comparison already passed under the prior loaded-selection behavior. This subtask did not run the gate.

The bounded correction now allows both `target` and `latest` IDs when that ID is present in the complete loaded conversation collection and `deletedAt` is null. An archived conversation remains a valid user-selected review. The optional `excludedConversationId` belongs only to the `latest` policy and is checked against `latest.room.activeConversationId` inside the revision-checked conditional updater. If the latest choice is the conversation this operation just archived, no selection overlay is applied and the repository's replacement is used. Archiving another conversation preserves the latest valid choice. Deleting the current choice similarly falls back naturally because a deleted conversation cannot satisfy the loaded collection/existence check.

| Read site | Final policy |
| --- | --- |
| `commitPatch` revision conflict | Explicit target for conversation/side navigation; latest for ordinary mutations. |
| `startConversation` completion | Its planned new conversation ID as explicit target. |
| `archiveConversation` completion | Latest, excluding this operation's archived ID at commit time. |
| `deleteConversation`, `deleteArchivedConversation`, `deletePersona` completion | Latest valid choice. |
| `appendMessages` superseded fallback `listMessages` completion | Latest valid choice. |
| `reloadWorld`, `refreshAll` | Loaded selection, retaining discard-on-superseded background semantics. |
| `openWorld`, `createWorld`, initial restoration | Loaded selection with their existing selection/effect guards. |

Every room read still calls the unfiltered `loadRoom(scope.roomId)` and retains all complete world collections for `bundleOf`/`locateTurn`. The overlay is UI-only: no stored active ID write, repository CAS change, public API change, collection filtering, generic merge removal, or additional merge layer was introduced. A later explicit background reload can reflect the stored choice; this work does not permanently repair the captured persistence race. No test/typecheck/lint/build/smoke was run by this subtask after the production correction. Root's centralized green/type gate and final independent review remain pending.

## 2026-10-08 root final evidence

Root ran the final 27-case SessionHarness: **27/27 passed** (`logs/session-policy-final-green.log`), followed by the complete web suite: **48 files / 328 tests passed** (`logs/web-final-closeout.log`). Whole-repository typecheck passed (`logs/typecheck-final-closeout.log`); after formatting only the new fixture's long assertions, lint passed for 439 files (`logs/lint-final-clean.log`). Final source was used for the actual production build, which passed with 190 web modules, fresh input/output provenance and a second-call reuse (`logs/production-build-closeout.log`).

The independent Sol xhigh reviewer completed two incremental static passes: both final Important categories addressed, specification and quality PASS, no new Critical/Important. The background loaded-selection and stored-active/CAS limitations above remain. A13's five web recovery/report cases pass within the web suite; malformed-marker world retention still requires the core owner's safety fix. No child agent ran these checks, no real model request was made, and no commit or deployment occurred.
