# Consolidated WhatsApp contribution
Objective: consolidate all existing changes into upstream PR #20; branch: feature/audio-and-drop; upstream base: main.
Delivery: single-pr (explicit user choice); existing PR ~3,000 authored lines, new work ~263 lines; checks: Node suite, lifecycle, QML runtime, package validation.

## Specs
S1. "todos los cambios en uno solo, elimina los worktree despues de verlos sincronizados con main"
S2. "Un PR al repositorio original" (selected option). "Un único PR a srineshr1/omarchy-whatsapp:main. Limpiar los worktrees después de que se fusione." (selected option description).

## Tasks
T1 | S1-S2 | inline | done | Bell and panel-behaviour pending work consolidated; existing loader check retained; 31 staging/send tests and repaired behavior runtime pass after observed RED. Risk: item 2 (staging rejects non-regular files); commits: pending.
T2 | S1-S2 | inline + independent verify | done | 106 Node tests, lifecycle, original panel/client loader, behavior and bell runtimes pass. Package validation and qmllint pass (host-type warnings); shellcheck unavailable. Independent verifier: no severe blockers; 31 focused tests and two QML checks pass in scratch. Commit: pending.
T3 | S1-S2 | inline | in_progress | Commit reviewable units, run due native review, push consolidated branch and update existing upstream PR #20; commits: pending.
T4 | S1-S2 | inline | pending | Remove secondary worktrees only after PR merge into upstream main and per-worktree preservation checks; commit: not applicable.

## Log
L1. User request: todos los cambios en uno solo, elimina los worktree despues de verlos sincronizados con main
L2. User answered "si" to a two-destination question; clarification tool selected "Un PR al repositorio original" with description "Un único PR a srineshr1/omarchy-whatsapp:main. Limpiar los worktrees después de que se fusione."
L3. Fresh GitHub evidence: PR #20 is OPEN, CLEAN, base main, head statick88:feature/audio-and-drop. Reuse this PR rather than creating a second PR for the bell. Issue #30 remains the nonclosing reference for notification controls.
L4. Root feature branch has uncommitted independent notification settings. Bell branch 2185f52 has the same backend/settings plus Panel.qml button and its runtime test. Original main and origin/main are a5e4f56, upstream/main is 50ffc94; none proves upstream merge. No worktree deletion is currently authorized by the user's condition.
L5. Independent read-only inventory (mw2qwdw2-1-wtf8): all ten correction heads are already ancestors of the feature branch; panel-behaviour additionally has five modified files plus untracked tests/panel_behaviour.qml. Bell has unique commit 2185f52 and local task notes. None of the worktree heads is in upstream/main. Preserve these changes before any cleanup.
L6. The panel-behaviour runtime draft references an unexposed composer, declares a duplicate chatsChanged signal and uses an invalid qs import root. Repair the draft as a separate behavior test, retaining the existing panel/client load check. The non-file staging guard and post-ack staged-file cleanup are part of the user's all-changes consolidation.
L7. RED: FIFO copy timed out (exit124, 5 seconds); delivery-failure test observed prematurely deleted staged copy; bell runtime failed because root lacked the control. GREEN: 31 focused Node tests and repaired behavior runtime pass. Added exact public stager error/exit/stdout assertion for FIFO. Explicit Commons.Color alias removes previously masked undefined-color warnings. No live WhatsApp account data was accessed or mutated.
L8. Independent high-risk verification mw2r71xo-2-ocqx: no severe blockers; 31/31 staging/send tests and panel/bell runtime checks pass in an isolated candidate. Device/directory rejection leaves no staging entries. Parent full suite: 106/106; lifecycle and original panel/client loader pass. Clean staged-package validation and qmllint exit0; shellcheck unavailable. Parent spot check of delivery-failure regression passes.
