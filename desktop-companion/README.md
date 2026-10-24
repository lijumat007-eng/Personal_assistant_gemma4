# Jarvis floating companion — Windows prototype

The existing expressive robot now floats in a transparent, frameless desktop
window. Click the character or Chat to expand the existing conversation panel;
drag the character to move it. Empty areas pass clicks to the desktop. Chat,
files, approvals, themes, browser speech, and microphone recording use the same
frontend and backend as the browser app.

## Setup and launch

Requires Windows x64, the existing project Python dependencies, and Ollama or
your already configured provider. No Blender, npm, or global Electron install
is required for this launch path.

From the project folder:

```powershell
python desktop-companion/install_runtime.py
./run_companion.ps1
```

Alternatively, double-click `run_companion.bat` after installing the runtime.
The setup downloads the official Electron 44.5.1 Windows archive (about 151 MB),
verifies its published SHA-256, and extracts it under `desktop-companion/runtime`.
It does not download a new language model or change the existing model.
The runtime is optional and is excluded from source control. If you already
use npm, the pinned package also supports `npm install` and `npm start` inside
this folder; do not install both runtimes unnecessarily.

The shell connects to `http://127.0.0.1:8000`, reusing a running Jarvis server.
Otherwise it starts `python -m uvicorn web_server:app --host 127.0.0.1 --port 8000`
with the project as its working directory. Set `JARVIS_PYTHON` to a Python
executable for direct Electron launches; `run_companion.ps1` sets it automatically.
Startup can take a while on the first import. An unrelated service on port 8000
is reported rather than replaced. Startup errors are written to `backend.log`.
Quit stops a backend this shell started, and leaves an existing server running.

## Everyday controls

- On launch, the window expands to **Choose reasoning**. Select Local to list
  installed Ollama models, or Cloud to enter a Gemini model and API key. Apply
  the choice or continue with current settings. Settings reopens the chooser.
  Model/provider choices persist; newly entered API keys last for the current
  server session. Local reasoning does not fall back to Cloud.

- Click the robot or Chat to open the interaction panel. Collapse chat with its
  header ×, Close chat, or Escape. The × beside the robot's ⋯ menu quits the app.
- Drag the robot to reposition it. Placement and size are saved and clamped to a
  current monitor's work area on startup and display changes.
- Ctrl+Alt+J shows and focuses chat. Showing through the tray preserves passive
  focus. A second launch summons the existing instance.
- Alt+F4 closes the companion when it has focus. Ctrl+Alt+Q quits from any app,
  including when the companion renderer is unresponsive. Close exits rather
  than hiding in the tray; Hide companion remains an explicit menu action.
- If the shortcut is unavailable, double-click `stop_companion.bat` in the project
  folder. It stops only this project's Electron processes and leaves a separately
  running assistant server alone.
- The ⋯ menu and system tray provide Wave, Dance, Files, Settings, Character
  controls, voice input, mute, size, always-on-top, hide/show, reconnect, and quit.
- Settings contains Light/Dark/Warm themes and provider selection. Character
  controls contains expressions, body colour, quiet idle, and additional gestures.
- Voice input is an explicit recording action. Closing chat or hiding the
  companion cancels recording. Hiding also stops speech. Stop voice remains
  visible while audio is pending or playing.
- Reset still uses the existing confirmation and memory-reset API. Approvals
  remain in chat until resolved, even when the panel is temporarily closed.
- If the backend disconnects, animation stays usable. Reconnect reacquires the
  session cookie without replaying requests or resetting the draft/conversation.

Preferences and Chromium data live in `.user-data/` in this folder, separately
from your normal browser profile. To change the shortcut, quit the companion,
edit `shortcut` in `.user-data/desktop-settings.json` to e.g. `Ctrl+Alt+K`, and
restart. If a shortcut is taken, the tray remains available. The app does not
register itself to start with Windows. Ctrl+Alt+Q is reserved for emergency quit.

Click-through is controlled by native cursor probes, with short-lived renderer
hit-test replies. Moving outside the character/controls, hiding, resizing,
reloading, or a renderer stall releases capture. Native menus retain their own
interaction until dismissed; interrupted drags also expire. Quitting has a
main-process fallback so a stalled renderer cannot keep the overlay running.

## Integration map

| Component | Reused implementation / addition |
| --- | --- |
| Assistant, memory, file actions | Existing `web_server.py` and LangGraph agent |
| Conversation and approvals | Existing `web_ui/app.js` and same authenticated REST APIs |
| Robot and speech effect | Existing `web_ui/robot.js`, CC0 RobotExpressive GLB |
| Desktop layout and ray hit testing | `web_ui/desktop.css` and `desktop.js` |
| Transparency, positioning, tray, shortcut | Electron `main.cjs` |
| Narrow native bridge | Sandboxed, isolated `preload.cjs`; no renderer Node APIs |

Only the trusted loopback desktop page can invoke the bridge. IPC validates the
sender frame and argument types. Navigation, new windows, downloads, camera,
and unrelated network resources are denied. Microphone permission is restricted
to audio from the local assistant page. Provider secrets stay in Python.
Window behaviour follows Electron's official
[window interaction documentation](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)
and [context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

## Verification

```powershell
node --test --test-isolation=none tests/desktop_policy.cjs
node tests/ui_overhaul.cjs
node tests/desktop_smoke.cjs
node tests/desktop_pointer.cjs
```

Run these from the project root. Browser/native checks require Playwright,
marked, and pngjs on the Node module path; the application does not require those
test packages. The native suite uses the installed runtime and an isolated
`.user-data-test/` profile. Assistant responses are mocked so it does not modify
personal conversation history. It temporarily moves the pointer over the robot
to verify native dragging, refuses to click unless the pointer is over its own
window, and restores the pointer afterward. The pointer regression suite creates
its own underlying window to test real clicks through transparent pixels and a
simulated renderer stall, then checks window close, native menu dismissal,
Alt+F4, the visible quit button, and the independent emergency shortcut.
It refuses to click another application.

Verified on this Windows machine: alpha transparency, native click-through flag
changes from ray hits, real Windows clicks into an underlying test window,
character hit/drag, capture release/recovery during a renderer stall, native
menu dismissal, close/Alt+F4/quit button termination, and emergency quit while
the renderer is stalled. Other checks cover always-on-top, shortcut registration,
compact/expanded layout, drafts, approvals, themes, drawer Escape/focus,
hide/show, reconnect, character controls, and bridge guards.
The UI working set was about 463–535 MB during native tests; Python,
Whisper, and Ollama are additional and were not included in that measurement.
This is not a full hardware performance benchmark.

For an optional live connection check, set `JARVIS_DESKTOP_LIVE=1` when running
`desktop_smoke.cjs`. This submits one harmless greeting through the real native
chat and adds that exchange to the assistant's normal conversation history.
All other test replies remain mocked.

For everyday Windows behaviour, also check manually:

1. Place it over Notepad and a browser. Confirm it stays visible, and empty
   areas let each application receive clicks. Check clicking and dragging the robot.
2. Try the shortcut while another app has focus; open/close chat and verify the
   draft stays intact. Open Settings and press Escape; chat should remain open.
3. Hide/show and mute through the tray, then quit/relaunch and check placement.
4. Move it between monitors with different scaling, disconnect a monitor, and
   resume from sleep. The automated test covers the current display, not every
   physical multi-monitor setup.
5. Try microphone permission denial, voice recording/cancellation, speech, and
   a real assistant request with the configured provider.

This stage does not implement Kokoro or phoneme lip sync, avatar uploads,
screen capture, or a packaged installer. It uses the existing browser/system
voice with the procedural speech-mouth effect. Closing the panel or stopping
voice does not cancel a backend tool execution; the current backend has no
cancellation API. No new provider, data migration, or screen access was added.
