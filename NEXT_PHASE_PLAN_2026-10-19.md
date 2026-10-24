# Jarvis next phase: Continue this project

Prepared 19 October 2026. Audience confirmed: a private Windows desktop companion for the owner's projects.

## Recommendation

Build a small, coherent release around this promise:

> Open a project and know where you stopped, what changed, and the next useful step.

The release should make returning to a project easier every day. Keep the existing robot as the entry point and a truthful status indicator. Use the selected reasoning model; do not change models as part of this phase.

This is a proposed four-week implementation sequence for one developer, with scope reduced if the initial privacy work takes longer. It is not a delivery commitment. The first useful release is a read-only project recap; existing reviewed file actions can follow after their safety gates pass.

## Current status

The project is a substantial desktop prototype. The old plan.md claim of 100% completion does not describe release readiness. ARCHITECTURE_REVIEW_2026-10-08.md remains broadly consistent with the current source; many of its proposed features are still proposals.

| Area | Implemented | Remaining limitation |
| --- | --- | --- |
| Reasoning and tools | LangGraph multi-step loop, 12 tools, selectable Ollama/Gemini, no automatic Cloud fallback in the active Local path | One global conversation/workspace; no bounded task queue, live response stream or backend task cancellation |
| Files and approvals | Shared workspace service, resolved paths, exclusive creates, reviewed edit diffs, content hashes, atomic edits/backups, call-specific approvals | Narrow credential exclusions, source folder is default workspace, API and agent mutation policy differ; delete has no undo |
| Desktop companion | Transparent Electron robot, click-through/drag, tray, shortcuts, saved preferences, emergency exit, native pointer recovery | General task recovery and persistent project memory are absent |
| Voice | Explicit microphone capture, Faster-Whisper transcription, browser speech output, robot reactions | Unbounded capture/upload, blocking transcription work, pending-microphone cancellation race; natural local TTS is unimplemented |
| Persistence | SQLite stores chat messages; graph uses MemorySaver | Stored chats do not restore a project, pending approval or interrupted operation |
| Efficiency and offline use | Lazy initial Whisper load, local robot assets, rendering caps and hidden-state pause | Markdown uses a CDN; quiet idle still redraws; total Python/Ollama/voice/Electron footprint needs measurement |
| Engineering | Python reliability tests and desktop/UI regression scripts exist | No Git repository detected in this checkout; Python dependencies are unpinned; live task quality is not established by mocked tests |

Concrete source anchors:

- command_framework/agent/agent_graph.py:90 and :183 — transient thread/checkpoints; :190 — accumulated messages passed to reasoning.
- command_framework/modules/file_manager.py:14 and :48 — default workspace and narrow private-path exclusions.
- web_server.py:47 — global mutation lock; :118 — separate timer manager; :198 — voice route; :301 — provider change; :484 — direct filesystem mutation endpoints.
- database.py:8 and :21 — database in the project and plain chat schema.
- web_ui/app.js:344 — send-and-wait chat; :616 — microphone capture lifecycle.
- web_ui/index.html:10 — external Markdown parser.
- desktop-companion/README.md:129 — historical Electron-only memory measurements; :151 — explicitly unimplemented features.

The existing architecture review records an i3 13th-generation / 8 GB target. Treat that as a design assumption until measured on the actual development machine.

## What can make Jarvis distinctive

The distinguishing experience is reliable personal project continuity. The useful memory is accepted decisions and unfinished work, tied to actual files and dates.

The signature card contains three short sections:

1. **Where we stopped:** the accepted goal, last verified result, unresolved decision, and date.
2. **What changed:** selected sources added, changed, missing or no longer accessible since the last checkpoint. A changed hash proves changed bytes, not a semantic explanation; offer a bounded diff before interpreting the change.
3. **Next step:** one user-editable suggestion, with the files or saved decision supporting it. It is a suggestion until the user starts it.

Save only user-accepted memory. Each fact should have provenance: a user confirmation, a verified tool outcome, or a selected file reference with a version/hash. Label model suggestions separately. If evidence changes or cannot be read, show that uncertainty and let the user correct the memory.

Support two simple actions: **Remember where I stopped** and **Continue this project**. A compact robot badge opens the card. Avoid repeated attention animations or automatic interruptions.

Local processing and desktop access have substantial overlap with existing products. AnythingLLM documents an OS-wide overlay with local/cloud model choice; Open Interpreter documents scoped workspaces and exact approval previews; Copilot Vision provides explicitly shared visual context. This comparison supports choosing a focused continuity workflow. It does not establish worldwide novelty or assert that competitors lack project memory.

- [AnythingLLM desktop assistant](https://docs.anythingllm.com/desktop-assistant/introduction)
- [Open Interpreter workspaces](https://www.openinterpreter.com/docs/desktop/workspaces)
- [Open Interpreter approvals](https://www.openinterpreter.com/docs/desktop/approvals)
- [Microsoft Copilot vision](https://support.microsoft.com/en-au/microsoft-365-copilot/get-started-vision-microsoft-365-copilot)

## Four-week sequence

| Stage | Dedicated scope | Acceptance gate |
| --- | --- | --- |
| Week 1: establish the private project boundary | Explicit project selection/grant; separate application data from source/user workspaces; broaden private-root exclusions; default Local-to-Cloud changes to fresh context; bound file/context/audio sizes; bundle Markdown locally; record a baseline | Unselected/private roots rejected; previous Local messages do not transfer unexpectedly; recap works without external frontend requests; resource baseline recorded |
| Week 2: save where I stopped | Add project/session IDs and a versioned project checkpoint; goal, accepted decisions, last verified artifacts, open question and next step; review/edit/forget controls; atomic persistence | Close/reopen retains the accepted checkpoint; projects do not share facts; stored memory excludes credentials, permission tokens and full transcripts by default |
| Week 3: return with evidence | Render the three-part card from stored facts; on open or explicit refresh, compare a bounded list of selected text files; offer source links and freshness labels; optional model explanation | External file edits make supporting facts stale; missing files are reported; the card appears without waiting for inference; nothing changes on disk merely by opening it |
| Week 4: make it a daily workflow | Robot entry point, keyboard access, checkpoint review at session end; after action-policy gates, reuse the existing reviewed edit flow for one bounded action and show a verified artifact result | Complete ten realistic return-to-project trials; every completion claim has tool/file evidence; saved proposed actions require fresh inspection/review; daily workflow is useful on the target machine |

Keep scope flexible inside these stages. If foundational fixes exceed Week 1, ship the read-only recap first and move additional action integration to the following release.

## Implementation boundaries

Retain FastAPI, SQLite, LangGraph, plain JavaScript and the optional Electron shell. Start with one local inference operation at a time. A new framework, distributed infrastructure and another reasoning agent are unnecessary for this release.

Suggested small additions:

| Component | Responsibility |
| --- | --- |
| Project store | Versioned project, session and accepted-checkpoint records; explicit deletion and migration |
| Source snapshot service | Bounded granted paths, hashes, timestamps, missing/changed status; text excerpts only on demand |
| Recap builder | Deterministic saved facts and change flags first; optional concise model explanation second |
| Checkpoint UI | Review, correct, accept and forget; distinguish saved facts from suggestions |
| Result receipt | Actual affected path, operation outcome, verification and time; mark uncertain operations clearly |

Checkpoint fields: project_id, session_id, schema_version, accepted_at, goal, accepted_decisions, last_verified_results, open_questions, accepted_next_step and selected_sources. Each source includes a project-relative path, hash and observation time. Each result references its verification evidence. Keep memory and consent records separate.

Suggested API surface: project list/create/select, checkpoint read/propose/accept/delete, and source-refresh. Require existing session authorization and project scope checks throughout. The recap endpoint is read-only. Opening a project must not trigger model tools automatically.

Store new application data in a dedicated user application-data directory, outside the agent-readable workspace. Migrate existing data only with a backup and defined rollback; do not silently relocate or delete the current personal database. Pin tested dependencies and establish version control before implementation; exclude credentials, database, runtime and private profiles.

After restart, saved proposed steps return as suggestions requiring fresh review. Inspect the actual target before starting a new action. Identify an interrupted write only when separately persisted operation evidence supports that conclusion; this checkpoint alone cannot detect it. Do not reuse previous approval tokens, replay side effects, or claim automatic task continuation. Persistent project memory is different from restart-safe task execution.

## Repairs required before expanding actions

These issues should not be hidden behind the new card. Deliver fixes in focused changes, and keep new recap functionality read-only until relevant gates pass.

| Repair | Evidence required |
| --- | --- |
| One server-side mutation policy for UI, agent and CLI | Equivalent operations receive equivalent policy decisions; approval binds exact target/version; avoid duplicate prompts for one authorized action |
| Typed success/partial/denied/error outcomes | Denied or failed requested steps never produce a successful overall receipt or celebration |
| Voice lifecycle and limits | Hide/cancel prevents recording even while microphone permission is pending; recording/upload bounded; full transcription iterator runs off the event loop; status remains responsive |
| Shared reminder service | Agent timer appears in API and can be cancelled through the UI; persistence and sleep recovery can follow separately |
| Accurate privacy controls | Local reasoning is distinguished from network search and speech output; a claimed Offline mode disables all outbound tools and uses verified local assets/providers |

## Definition of done

These are proposed acceptance targets, not measured current results:

- Run ten real project-return trials across at least two projects. At least nine should produce a useful accepted next step with no more than one factual correction per trial. Record failures rather than hiding them in an average.
- Reduce median time from opening Jarvis to choosing the next useful action by at least 50% compared with the same manual resume workflow. Define this as orientation time, separate from completing the action.
- Display stored recap content within one second on the target machine; model-generated explanation may arrive later. Test a fixed bounded source set rather than an arbitrary whole drive.
- No cross-project facts, unintended Cloud context transfer, credential exposure or automatically replayed write in the focused acceptance scenarios. These checks are not a general security guarantee.
- Changed or unavailable evidence is visibly marked; unverified completion is never presented as verified.
- Pass relevant existing reliability/UI/desktop regressions and add focused persistence/isolation/stale-source cases. Evaluate live model behavior separately from deterministic code tests.
- Measure whole-process-tree RAM, idle CPU, startup, recap latency and inference latency, including Ollama and voice. Set the memory budget from this baseline; do not use Electron-only figures as total usage.
- Use the companion daily for one week and retain a short log of incorrect memories, unwanted interruptions and actions requiring manual repair.

## Deliberately later

After the continuity loop proves useful, prioritize durable task execution with operation reconciliation, progress events and cancellation; then safe recovery/undo and user-reviewed reusable routines. Source-linked web research can become another workflow once the search tool returns titles and URLs.

Instant voice access and natural talkback remain valuable follow-ups from the existing architecture review. First fix recording/transcription lifecycle; then add a configurable toggle shortcut and benchmark local speech output alongside reasoning. Preserve separate recognition, reasoning and speech-output privacy settings.

General multitasking, arbitrary screen control, always-listening audio, full-disk indexing, vector memory, custom avatars, phoneme lip sync and shell replacement are outside this release. Full undo requires a real operation journal and conflict handling; an existing backup directory alone is insufficient.

## Demonstration

Select a small project and accept its goal. Record the last completed work and save the next step. Close Jarvis. Change one relevant file externally. Reopen Jarvis: the robot offers the saved project card, shows the changed source and lets the user correct the next step. This is a complete read-only demonstration of continuity, evidence and user control. After the action-policy gates pass, optionally extend it by reviewing one proposed edit and opening its verified result.

## Review validation

First-party source, existing plans, tests and current official comparison documentation were reviewed. Credentials, personal notes and database contents were not read. Application code and configuration were not changed.

Verification performed in this review:

- File safety suite: 8 checks run, 6 passed and 2 skipped because junction/symlink creation was unavailable in this session.
- Agent approval/provider checks: all 4 completed and passed before the full Python run stalled at its first API test.
- Desktop policy suite: all 6 passed.
- JavaScript syntax checks passed for app.js, security.js and desktop-companion/main.cjs.
- The full Python run was stopped after the API test stalled. A separate localhost status probe was denied by the environment's socket restrictions. The cause of the test stall was not established; API behavior and live server health remain unverified here.
- Browser and native integration scripts were not rerun; Playwright and marked were unavailable on the current Node module path. No live model, microphone, screen-reader or whole-application performance benchmark was performed.

These results support specific code boundaries; they do not establish end-to-end task quality or a fully offline/private product. This review created only this plan as a lasting project change.
