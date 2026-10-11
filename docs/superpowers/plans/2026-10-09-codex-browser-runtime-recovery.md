# Codex Browser Runtime Recovery Plan

Date: 2026-10-09

## Purpose and status

This document records a safe recovery sequence for the Windows sandbox setup failure that prevents CUA's built-in browser from initializing. The work so far is diagnostic and preparatory. The issue has not been repaired, and no successful recovery is claimed.

## User-directed stop and project continuation

The user asked to ignore the initialization issue, try obtaining Computer Use again, and continue the project. The official installed CLI's `plugin add computer-use@openai-bundled --json` exited0. A post-install listing confirmed installed=true and enabled=true, with the unchanged bundled version26.1002.52244. This establishes local plugin re-obtaining only; it does not establish a newer remote download, plugin-list visibility or browser recovery. No further initialization, setup, host restart or package inspection is planned under this request.

The previously prepared bounded MSIX metadata reader stopped at an unsupported ZIP64 entry-count marker (exit1); no package was installed or payload executed. That investigation is now stopped. The known ledger byte hash and1/48, quality1/44, ¥0.01213 baseline remain;6285 is offline and no Key-entry window is pending. Project closeout and remaining external acceptance boundaries are in the [26-item matrix](./2026-10-09-ui-bridge-ops-closeout.md). The recovery sequences below are historical plans, not current instructions to restart troubleshooting.

## Latest state after complete restart

### After the successful offline setup

The user completed the quiet-window script. `logs/codex-offline-repair-20261009-153641.log` shows owners22→9→1→0, both descendant censuses0, a validated elevated success=true notification, readiness=ready, and normal server exit0 after waiting for closure. All three ledger byte checks retained the known270e... SHA. No model request or repeated ledger recovery occurred.

After reopening at15:46:57+08, root's harmless default command still failed before process creation. Cua reset worked, but first `getState()` exited1 with setup refresh error. Safe filtering of15:49:41 logs again identifies root-only runtime ACL open, target `node_repl.exe`, os error32. Current app/server and tool kernels have new, verified start times; no new process was recycled. Loopback6285 is now unreachable after app exit; unchanged journal bytes do not establish live locked status. No further host restart or lock mutation was attempted.

Official [PR51822](https://github.com/openai/codex/pull/51822), merged October7, addresses active EXE/DLL sharing failures from `MAXIMUM_ALLOWED` during runtime ACL repair. The installed CLI's exact source tag0.162alpha2 uses the old file-open path on every refresh, even when existing RX ACEs are sufficient. This is a strong match to the observed failure, not a verified source-to-installed-helper binary match. Current helper SHA256 is `AB7B6F92A7FC6CF75230FF1EF212D1FDC3C242391B77E6491B0DABA274174480`; it has no PE FileVersion/ProductVersion value. No public configuration fix preserving current tool and sandbox protection was identified. Repeating setup or terminating more helpers is not the next step.

The official Windows product is now ChatGPT/Codex, Store ID9PLM9XGG6VKS. Exact WinGet inventory confirms it is the existing version26.1002.7124.0. Name-only Codex searches therefore did not identify the product. Download-only WinGet failed requiring an administrative environment and produced no files; no installation occurred. The official deployment page provides a Store-signed x64 MSIX link. HEAD reports912043391bytes, modified October6; only bounded archive metadata inspection is being prepared, not package installation or payload execution. Its date alone does not establish whether the fix is present. Desktop/Store rollout containing the fix remains unverified.

Computer Use's official product documentation supports Windows as well as macOS; Mac wording in public directory cards does not establish Windows ineligibility. Local enabled configuration and tool availability also do not establish plugin UI/account availability. That symptom remains independently unresolved.

The user has now fully exited and reopened Codex. The new app-server parent started at 2026-10-09 14:28. Both the harmless default shell probe and reset Cua `getState()` still fail with `helper_unknown_error: setup refresh had errors`; normal restart has not fixed the issue.

Root verified the journal's complete hash chain, last checkpoint `a5918101719838c48c3177a90230e232f8d00c49ac635ab64674e1bc7a62591b`, unchanged byte hash `270eaf03a9cd89586ac5dbdae8aa26d904505a075daa5e06f1f544f9081ffce1`, dead old lock PID `10956`, and free port 6285. Root preserved the old lock and verified ledger copy, then restarted only the approved 4096 host without initialize or recovery arguments. Current host PID `46992` owns the exact lock and loopback listener; online mode is locked, busy=false, requests=1, qualityRequests=1, spentCny=0.01213. Node read-only byte comparison after restart confirms the journal is unchanged. PowerShell's final active-file hash attempt failed on Windows sharing; that failure was not counted as a successful check.

The installed CLI's generated standard schema exposes public `windowsSandbox/readiness` and `windowsSandbox/setupStart`. A standalone public stdio connection returned readiness `ready` and closed normally (exit 0); metadata readiness does not prove command execution works. One official elevated setup attempt has since completed unsuccessfully; details follow. The earlier sequence and guardrails below reflect the pre-restart observation; the stale lock prohibition applied before ownership reconciliation and does not describe the new active lock.

## Official setup and update follow-up

Root invoked the current version's public `setupStart(mode=elevated)` once after full restart. It returned started=true, then a validated elevated completion notification reported success=false and setup refresh error. The standalone server closed normally. Post-setup readiness remained ready while the default harmless shell still failed; filtered sandbox evidence still reports runtime ACL os error32. No success was inferred from metadata.

The application information-only update check returned unavailable for the Windows Store implementation. The user then authorized Store checking/downloading. WinGet did not return the official installed Codex product; no unrelated search result was used. The installed-package PFN Store page was launched, and the user reported only Open, with no Update action. No app update was downloaded or installed. See the [safe bug report](2026-10-09-codex-browser-runtime-bug-report.md).

## Current offline repair handoff

Root checked the current active chats and precise executable/start-time/parent ownership, then recycled only the two verified tool kernels once (PIDs 27728/36288). The fatal ACL target moved to `VCRUNTIME140_1.dll`; a read-only module census identified exactly one loader, the app-owned `codex-computer-use-swift.exe` PID39732. Root revalidated its identity and stopped only that helper once. The fatal target then returned to `node_repl.exe`, and default execution still failed. No additional helpers are being chased or terminated. Cua currently reports Transport closed after the tool-service recycling; this is not recovery.

The next attempt needs a quiet window with the application closed. Local ignored artifacts are `logs/codex-offline-sandbox-repair.ps1`, `logs/codex-public-sandbox-setup.mjs`, and `logs/codex-repair-ledger-check.mjs`. The user starts the PowerShell script from a separate system PowerShell, then quits Codex normally and keeps it closed until a definite result. The script rejects Codex-owned launcher ancestry, waits for two quiet snapshots, and includes both WindowsApps package processes and the app-server CLI outside that package, plus all `cua_node` runtime processes. It never kills a process. Independent system Node and the locked validation host are outside the exit predicate.

Only the repair subprocess receives the documented CLI feature flag `--disable code_mode_host`. It does not write persistent tool configuration, downgrade the sandbox, or change ACLs manually. Root's read-only preflight of that subprocess returned ready and exited0; two descendant censuses reported runtimeDescendants=0, knownHelperDescendants=0, unknownPaths=0. The adapter requires these checks before any setup request. The offline setup itself has not run yet.

Once quiet, the script issues one public elevated setup request and waits for the validated completion notification. A pending setup is not interrupted or declared successful. Filtered logs and byte-for-byte SHA checks preserve the approved journal; there is no initialize/recovery, retry, Key access, or model call. Official setup success still requires reopening Codex and demonstrating default shell execution, Cua built-in page readability, and unchanged ledger/lock ownership. Missing plugin-list UI remains a separate unresolved symptom; local enabled configuration alone does not establish account/UI availability.

Final independent Sol6.1 static review passed after removing automatic own-server termination: both setup and close timeouts only report and wait. Root parsed the PowerShell script without syntax errors, confirmed all three operational scripts remain ignored, and read the ledger's unchanged fixed SHA. No offline repair was executed and no project test suite was repeated during this handoff.

The first user run remained at WAITING with increasing process counts and no setup-start message. Its initial blank count exposed Windows PowerShell5.1's single `Select-Object` record `.Count` compatibility issue. Root's direct Windows PowerShell5.1 language probe observed zero=0, single=null; explicitly array-wrapping the caller now yields 0/1. The one-line adjustment passed independent static review. This fixes counting/display, not the runtime failure. The application must remain closed until the offline script produces a definite completion or a pre-setup timeout; reopening to send progress keeps the exit predicate nonzero.

## Earlier diagnostic facts

- `computer-use@openai-bundled` and `unified-computer-use@openai-bundled` both report `enabled=true`.
- CUA's built-in browser initialization reports `windows sandbox failed: helper_unknown_error: setup refresh had errors`.
- The sandbox log identifies the fatal setup failure as `os error 32` while updating the ACL on the runtime `node_repl.exe`; the file is in use.
- The runtime file exists, and its ACL already grants `CodexSandboxUsers` `ReadAndExecute`.
- An earlier observation found six runtime parent processes alive, without establishing whether they belonged to this chat or were orphaned. The latest read-only check found two shared runtime parent processes alive; ownership remains unverified.
- The last confirmed host state was locked. It is currently unreachable: port `6285` has no listener, the host shell session `57729` no longer exists, and `ledger.json.lock` remains with PID `10956`; that PID's owner has not been verified. Do not infer that the host is clean or that the ledger is currently usable from the connection failure.
- A read-only ledger check verified the complete hash chain. Checkpoint: `a5918101719838c48c3177a90230e232f8d00c49ac635ab64674e1bc7a62591b`; ledger SHA-256: `270eaf03a9cd89586ac5dbdae8aa26d904505a075daa5e06f1f544f9081ffce1`. It reports `requests=1`, `quality=1`, `spent=0.01213`, `halted=false`, and one entry with status `budget-truncation`. No new call was made. The 4096 recovery is complete.
- The user confirmed Codex has not been fully exited; they had only closed a window or continued chatting.
- The current default shell probe still fails with `windows sandbox failed: helper_unknown_error: setup refresh had errors`.
- Native APIs are disabled in this environment. That is an independent boundary; built-in browser recovery cannot establish that desktop control is available.

These facts support a diagnosis of a runtime setup file-in-use failure. They do not establish why any plugin UI disappeared or what capabilities the account has. The connection refusal on port `6285` is not evidence that the host or ledger is clean.

## Guardrails

- Do not edit or replace runtime binaries, change ACLs or sandbox modes, kill process groups, or uninstall/reinstall Codex.
- Do not bulk-kill the six runtime parents. Their ownership and lifecycle are unverified.
- Do not repeat the 4096 recovery, clear or reset the ledger, or retry the first item. The last confirmed state of host `6285` was locked, but it is currently unreachable. Before any recovery action that could send work, re-check the ledger, lock state, and lock owner through the proper host path. Do not send anything until those checks succeed and establish that sending is safe.
- Do not move or delete `ledger.json.lock`, or modify the ledger. PID `10956` has not been verified as the lock owner.
- Make no new model calls during this recovery. The acceptance check is that the ledger remains unchanged and no new model call appears.
- Enter the Key only in the built-in isolated page when the authorized user performs that step. Never read, copy, export, print, log, or otherwise expose the Key. Do not continue in external Edge.
- Keep diagnostics free of secrets and avoid opening or copying sensitive logs, configuration, databases, or Key material.
- Native desktop APIs remain disabled. Do not describe a successful browser check as proof of general desktop control.

## Recovery sequence

### Before restarting

1. Treat host `6285` as unavailable. Its last confirmed state was locked; the current port has no listener. Retain the verified ledger baseline (`requests=1`, `quality=1`, `spent=0.01213`, one `budget-truncation` entry, `halted=false`) and hash-chain/checkpoint evidence above. Before sending any work after recovery, re-check the ledger, lock state, and lock owner. Do not send work if any check is unavailable or ambiguous.
2. Confirm that the 4096 recovery is already complete. Do not invoke it again.
3. Fully exit Codex through its normal application quit/exit action; closing a window or continuing the chat does not complete this step. Save any needed user work first. Do not terminate runtime processes manually or through a bulk process command.
4. Wait for the application to close normally. Do not delete, replace, or edit runtime files or ACLs. Do not move or delete the ledger lock.

### Restart and retry

5. Reopen Codex normally, return to the current chat, and allow startup to finish.
6. In the default sandbox shell, run only a harmless basic command to confirm the shell starts and can execute. Do not run a build, test suite, browser automation, or model call.
7. After shell recovery, re-check host `6285` through its proper status path, including the ledger, lock state, and lock owner. Do not send any work unless those checks establish a safe, usable state. Preserve the verified baseline and do not repeat the 4096 recovery or retry the first item.
8. Retry CUA initialization for the built-in isolated browser. Confirm that initialization completes without the Windows sandbox setup error.
9. Open the intended page in that built-in isolated browser and confirm that the page renders and its visible content can be read. Do not enter or inspect the Key unless the authorized user is carrying out the intended task directly in that page.
10. Confirm that no new model call was made and that the verified ledger baseline remains intact.

### If initialization still fails

11. Stop the retry sequence. Record the exact user-visible error and time, without copying sensitive logs or configuration.
12. Consult the official [Windows sandbox recovery guide](https://learn.chatgpt.com/docs/windows/windows-sandbox) and the [Computer Use guide](https://learn.chatgpt.com/docs/computer-use) for the CUA-specific steps. The current official Windows page may show a Codex CLI sandbox setup example; the installed CLI's `sandbox --help` has no `setup` subcommand, so do not copy that CLI command. First identify the actual Codex app/setup entry point documented for this installation, then use the official elevated-setup troubleshooting path if it applies.
13. Keep the guardrails above in force while following the applicable official procedure. Do not improvise binary, ACL, sandbox-mode, lock-file, ledger, or process-kill changes. If the official guidance calls for an action outside those guardrails, record the instruction and reassess before proceeding.
14. After any documented troubleshooting attempt, repeat only the harmless default-shell check and the built-in CUA initialization/page-readability checks. Re-check host `6285`, the ledger, lock state, and lock owner before any work could be sent. Make no model call.

## Success criteria

Recovery is successful only when all of the following are observed after the normal restart:

- A harmless command runs in the default sandbox shell.
- CUA initializes its built-in browser without the sandbox setup error.
- The target page renders and its visible content is readable in that built-in isolated browser.
- Host `6285` is reachable and its status, ledger, lock state, and lock owner have been checked successfully; the ledger hash chain and verified baseline remain intact, and no new model call appears.

This result confirms built-in browser availability for the checked page. Since Native APIs are disabled, it does not establish desktop control. Until all criteria pass, report the issue as unresolved and diagnostic only. A failed status connection or an unreachable port does not satisfy the host or ledger criteria.
