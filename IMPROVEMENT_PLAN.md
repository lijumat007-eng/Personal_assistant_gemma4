# Jarvis: source review and improvement roadmap

Reviewed: 1 October 2026. Scope: the Python backend, LangGraph agent, tool wrappers, safety layer, voice CLI, browser UI, launch script, dependencies, and existing documentation. Credential files and personal database contents were not read.

### Implementation progress — 2 October 2026

The first safety implementation is now in place: a shared workspace service,
resolved path confinement, exclusive creation, recoverable atomic edits with
approval diffs and reviewed-content hashes, one tool call per checkpoint,
call-specific approvals, repeated-approval handling, explicit failed steps,
sanitized Markdown/escaped metadata, token/Host/Origin checks, a content security
policy, appropriate filesystem API errors, and a single-process mutation guard.
Whisper initialization was made lazy to support isolated API tests.

Offline regression coverage exercises file preservation, backups/conflicts,
workspace boundaries, Windows junction escape rejection, approval replay/denial,
edit previews and changes during approval, authentication, and API error codes.
Native symlink creation is unavailable in this Windows session; that test is
skipped. Live provider/microphone and browser rendering have not been exercised.

This is the first implementation increment, not completion of the entire
roadmap. Remaining work includes offline UI asset packaging, broader credential
policy, durable checkpoints/session isolation, timers/CLI/model fixes, voice
validation, streaming/cancellation, and the task-quality evaluation milestone.
The checks are designed for one Uvicorn worker; cross-process isolation is not
implemented. Filesystem validation does not constitute isolation from another
process maliciously changing filesystem links during an operation.

## What has been built

Jarvis is a working prototype architecture for a Windows assistant with a developer workspace:

- FastAPI serves a three-column browser UI and APIs for queries, approvals, workspace selection, files, timers, and model configuration.
- `JarvisAgent` implements a model → tools → model loop using LangGraph, typed LangChain tools, in-memory checkpoints, and approval interrupts.
- Twelve tools cover files/folders, basic Excel generation, search, timers, application launching, and date/time.
- Ollama is the default local provider; Gemini can be selected and is also an automatic fallback when available.
- Browser audio is encoded as WAV and transcribed with Faster-Whisper; speech output uses browser synthesis. A separate CLI supports typed and microphone input.
- SQLite records chat messages, while actual agent conversation state lives in `MemorySaver`.
- The frontend has an explorer, file preview, model controls, themes, command palette, step history, and an animated background.

The architecture is useful, but the existing `plan.md` claim of “100%” completion overstates reliability. It is a prototype with several disconnected services and incomplete recovery paths. `test_folder/reverse.py` is a generated example, not an automated test suite. No Git repository was detected in this checkout.

## Findings that determine the priorities

| Priority | Evidence in the source | Practical consequence |
| --- | --- | --- |
| P0 | `FileManager._is_within_project` accepts either `working_dir` **or** `project_root`, and resolves lexical paths without resolving filesystem links. | Selecting a workspace does not exclusively confine operations to it; links/junctions need explicit handling. The original-project exception was confirmed by calling the predicate with a temporary selected workspace. |
| P0 | `create_note` opens files with `w`; `create_excel` also saves to existing names; these tools are auto-approved. | A “create” request can replace existing work without a preview or backup. |
| P0 | `app.js` inserts Markdown through `marked.parse` into `innerHTML`, and interpolates filenames, tool arguments, and results into HTML. | Untrusted chat/file/search content can become active browser markup. |
| P0 | `verify_token` accepts a `Sec-Fetch-Site: same-origin` header without checking a token. | The session token is not consistently enforced; non-browser clients can forge this header. This alone is not proof of a remote browser exploit, but the boundary needs correction. |
| P0 | The entire batch of tool calls runs inside `_tool_node`, with `interrupt()` potentially reached after earlier calls have performed side effects. | Because interrupt resumption re-enters the node, prior calls can replay. This needs a focused integration test with the installed LangGraph version before the fix is considered verified. |
| P1 | One global agent, `active_thread_id`, and mutable tool workspace serve every request; query calls run in worker threads. | Overlapping queries, provider switches, memory resets, or workspace changes can mix execution state. |
| P1 | The tools use `_reminders`; the API uses a different `reminder_mgr`; the CLI creates another manager. | Timers started by the agent do not appear in the API timer store. Browser users receive no timer completion event. |
| P1 | `submitApproval` clears its approval ID and assumes a final response; CLI `process_command` handles only one approval. | A second approval in the same task cannot be handled correctly. |
| P1 | CLI startup calls `handler.llm.warm_up()`, but `CommandHandler` has `agent` and no `llm` attribute. | The CLI startup path will fail when it reaches this call. |
| P1 | `_init_models` hardcodes Gemini's model, while configuration/status expose a selectable name. | The reported configured Gemini model can differ from the model actually used. |
| P1 | Local model failures automatically send the messages to Gemini when a key exists. | Local mode can transmit conversation and workspace content to a cloud provider without a separate fallback preference. |
| P1 | File functions return prose errors; create/delete API routes often return `status: success` regardless. `read_note` catches its own raised HTTP exception. | Failed work can look successful, and expected client errors can become HTTP 500 responses. |
| P1 | Whisper is preloaded during module import despite a lazy-loader comment; transcription returns segments that are iterated on the async request path. Non-16 kHz audio only produces a warning. | Text startup depends on speech initialization, transcription iteration can block other requests, and input sampling rates can be interpreted incorrectly. |
| P2 | Timeline rendering occurs after the full HTTP response; typewriter animation reparses Markdown per character and replaces the same container holding the trace. | There is no live step feed; animation can remove trace markup and interfere with another response. |
| P2 | `MemorySaver` is transient; SQLite messages have no conversation/workspace IDs and are not restored into the current agent. | History logging does not provide restart-safe agent memory or resumable approvals. |
| P2 | Search returns three scraped snippets without source URLs or titles. | Research answers cannot be meaningfully checked against their sources. |
| P2 | Dependencies are unpinned; legacy `llm_integration.py` remains alongside the newer agent; UI scripts load from CDNs. | Installation and offline operation are less reproducible than the documentation suggests. |
| P2 | `_safe_name` rewrites filenames and has a short extension list; empty replacement text is converted to `None` in the tool wrapper. | Normal developer paths/names may change unexpectedly; replacing text with an empty string fails. |

## Phase 1: protect files and make execution trustworthy

Deliver this as the first implementation milestone. Avoid adding tools until these checks pass.

1. Introduce one workspace service used by both API routes and tools. Constrain paths to the selected root, handle Windows casing/drives and symlinks/junctions, and reject protected workspace roots. Validate workspace selection before changing state; return an error when it fails.
2. Make file creation exclusive by default. Treat replacement as an explicit update with a diff, expected content hash, atomic write, and recoverable backup. Preserve exact supported filenames and intentionally empty content; separate reads from directory creation.
3. Sanitize rendered Markdown and use text nodes for file/tool metadata. Keep internal UI markup separate from user/model content. Add a restrictive content policy and bundle required UI assets for offline use.
4. Require the actual session token consistently. Validate Host and browser origins on sensitive requests, configure CORS headers deliberately, and stop logging the token. Preserve direct UI deletion only as an explicit, confirmed user operation with the same path validation.
5. Move execution to one tool call per graph execution unit, or checkpoint each completed call before reaching an interrupt. Bind approvals to a specific pending call and run; reject stale, duplicate, or wrong-session approval decisions.

Acceptance checks:

- Traversal, sibling roots, cross-drive paths, and link/junction escapes are blocked through both tools and direct API routes.
- Existing files survive an ordinary create request; concurrent changes cause a conflict instead of a lost update.
- Script-like content in messages, filenames, and results displays inertly.
- Missing/invalid tokens are rejected even with a forged fetch metadata header.
- A batch containing an append, two approval actions, and a timer executes each approved action once across pause/resume; denial does not replay earlier operations.

## Phase 2: fix the user-visible broken paths

Depends on the execution boundaries from Phase 1.

1. Inject shared file, reminder, and system services into tools, API, and CLI. Remove unused duplicate service instances.
2. Use one result handler for text, voice, and approval responses. Continue presenting approvals until the task completes; show failure/cancelled states accurately and prevent duplicate submissions.
3. Replace prose-only tool results with typed outcomes: status, data, error code, and message. Render explicit running/success/failed/blocked/denied states. Preserve intended HTTP error codes.
4. Repair the CLI warm-up path and repeated approvals; carry its speech callback into the actual reminder service.
5. Honor configured model names. Initialize and validate a replacement provider before committing configuration. Report the provider/model actually used, including fallback.
6. Add an explicit cloud-fallback setting, defaulting to disabled for local mode. Keep credentials outside workspace content and exclude them from assistant file access and future version control. `key.txt` and `aws_pass.txt` are present by name; their contents/exposure were not assessed.
7. Load speech support on demand, process transcription and segment consumption together in a worker, resample or reject incompatible audio, and cap upload size/duration. Ensure microphone resources and UI status recover after failures.

Acceptance checks:

- A tool-created timer appears in the API, can be cancelled, and produces a browser completion notification; the CLI can announce it.
- Two approvals in one task work in both interfaces, including denial and retry after a network error.
- Missing files return 404, invalid paths return a suitable client error, and failed mutations never report success.
- The CLI reaches its input loop; text-only server startup works when speech assets are unavailable.
- Model selection matches the actual client, and a local failure sends no cloud request when fallback is disabled.

## Phase 3: sessions, persistence, and responsive execution

1. Give each conversation a stable ID associated with its workspace; persist messages, runs, steps, and pending approvals in SQLite. Use a durable LangGraph checkpointer through an injected lifecycle, rather than recreating memory inside graph construction.
2. Initially allow one active run per conversation and lock its workspace/provider for the run. Return a clear busy/conflict result for overlapping requests; later support independent conversations with isolated services.
3. Add run IDs and a server-sent event feed for tool start/result, approval, final response, and timer completion. Add reconnect support and deduplicate events. Use token streaming only where the selected provider supports it.
4. Add explicit tool/iteration limits, provider timeouts, and cancellation between steps. Cancellation must not claim to undo an already completed side effect. Retry reads/model calls selectively; do not blindly retry writes or launches.
5. Bound conversation context using recent messages plus a persisted summary, retaining pending tool-call/result relationships. Make the reset behavior explicit and scoped to the selected conversation.
6. Make explorer scans lazy and bounded, skip excluded directories, prevent link escapes, and move disk scans off the async event loop.

Acceptance checks:

- Refresh/restart restores the selected conversation and pending approval without repeating finished writes.
- Workspace/model changes cannot redirect an in-flight task; two independent conversations do not share history.
- The first tool event appears before the final response; reconnecting does not duplicate steps.
- A runaway mocked agent terminates at the configured limit; cancellation prevents subsequent calls.
- A large explorer does not prevent status/query endpoints from responding.

## Phase 4: improve actual task completion quality

1. Add source-code search, exact file reads, and validated patch operations with previews and content hashes. Preserve filenames such as `Dockerfile`, `.env.example`, and `.tsx`; explicitly deny real credential files. Fix empty-string replacements.
2. After safe editing works, add a constrained validation runner for approved project checks. Use argument lists, fixed working directories, timeouts, output limits, and a narrow command policy. Run untrusted generated code only in an appropriate isolated environment; do not introduce a general shell tool as the default.
3. Return structured search results with title, URL, and snippet. Separate fetched content from trusted instructions; validate fetch destinations if page retrieval is added. Link sources in research responses.
4. Give spreadsheet generation explicit formatting and value validation. The present implementation appends rows to a workbook but does not implement the advertised formatting.
5. Create a repeatable evaluation set: multi-file creation, safe editing, a missing file, tool failure, repeated approvals, research with sources, a timer, and English/Malayalam voice samples. Score task correctness and file outcomes alongside latency and tool-call count.
6. Benchmark the configured local/cloud models on this task set before changing model defaults. Choose models based on observed tool-call validity, completion rate, latency, and hardware constraints.

Acceptance checks:

- A coding task can inspect → patch → validate → report actual results without overwriting unrelated changes.
- Research responses link the returned sources and distinguish missing evidence.
- Evaluations assert final filesystem/results, not only fluent assistant replies. Record a baseline before setting improvement targets.

## Supporting delivery work

- Start a real regression suite with fake models, temporary workspaces, mocked search/audio, and FastAPI service injection; do not require live paid calls for ordinary tests.
- Lock the dependency versions that pass the supported Python/Windows setup. Split optional voice dependencies from the text core and document first-run model downloads.
- Introduce a Git repository and ignore secrets, databases, generated user files, caches, and temporary uploads before the first commit. Do not silently include existing credentials.
- Consolidate configuration and remove legacy code after verifying it is unused. Update README and `plan.md` to distinguish implemented, verified, and planned behavior.
- Add logs keyed by run/conversation IDs, durations, and error codes. Redact credentials and avoid logging full private tool arguments by default.
- Add keyboard focus handling for modals, readable error states, and reduced-motion support. Replace per-character Markdown reparsing with bounded rendering in a separate response element.

## Suggested order of work

| Milestone | Main outcome | Completion gate |
| --- | --- | --- |
| 1 | Safe workspace, file preservation, inert rendering, reliable approvals | All Phase 1 acceptance checks |
| 2 | Timers, CLI, model selection, errors, and voice behave consistently | All Phase 2 acceptance checks |
| 3 | Restart-safe conversations and genuinely live task progress | All Phase 3 acceptance checks |
| 4 | Better verified coding/research/assistant performance | Phase 4 evaluations show improvement over the recorded baseline |

The recommended first change is a tested workspace/file service, followed immediately by approval execution and rendering safeguards. These changes make every later capability safer to build and easier to verify. New visual effects and additional integrations should follow demonstrated task reliability.

## Review validation and limits

- All 17 Python source files passed AST parsing; both browser JavaScript files passed `node --check`.
- The original-project containment exception was confirmed by invoking the actual path predicate with a different selected workspace.
- A temporary-file check for overwrite/empty-content behavior hit filesystem permissions before writing successfully; those findings are based on source inspection. Temporary-directory cleanup also reported a permission error, so a directory named `tmp0rchnmxt` may remain.
- The full server, model providers, microphone flow, and interrupt replay behavior were not executed. Several modules initialize models/databases at import time; isolate those dependencies before integration testing.
- This roadmap changes documentation only. It does not claim that the listed fixes are implemented.
