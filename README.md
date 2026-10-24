# Jarvis - Autonomous AI Agent & Developer Workspace

Jarvis is a local-first **Autonomous AI Desktop Assistant** powered by **LangGraph** and **Faster-Whisper**. Its minimal chat interface supports multi-step software tasks, research, file organization, and desktop automation. Files and settings open on demand through one menu.

At startup, **Choose reasoning** offers **Local · Ollama** or **Cloud · Gemini**.
Local lists the models installed in the configured Ollama instance, with Refresh
and guidance when Ollama is offline or has no models. Cloud accepts a Gemini
model name and API key. Choose **Use selected model** to apply, or **Use current
settings** to continue. Reopen this chooser through Settings at any time.
Provider/model choices are remembered in `config.json`. New API keys entered in
the UI stay in server memory for that server session; they are never returned to
the browser or written to browser storage/configuration. An existing key from
`GEMINI_API_KEY` or `key.txt` can still be reused. Selecting Local disables
automatic cloud fallback. Cloud credentials are checked on the first model request.

## Expressive robot preview

Start the server, then open http://127.0.0.1:8000/?companion=robot or choose
**Menu → Robot companion**. Try Wave, Dance, and Test voice. Expand Character
controls for more gestures, expressions, three body colours, and quiet idle.
The robot reacts to work, recording, errors, and unresolved approvals. Closing
the preview preserves the conversation and draft. Body colour is remembered.

The CC0 RobotExpressive asset and MIT Three.js 0.180.0 runtime are local files;
Blender and a frontend build step are not required. The renderer caps its pixel
ratio at 1.5 and frame rate at 30, pauses while hidden, and respects reduced
motion for idle. Actual performance depends on the browser and graphics driver.
Model credits and source are in `web_ui/assets/robot/ATTRIBUTION.md`.

The optional Windows desktop shell is now available. Install its runtime once
with `python desktop-companion/install_runtime.py`, then double-click
`run_companion.bat`. It reuses a running Jarvis server or starts one if needed.
Click the robot to open chat, drag it to move, and use its menu or system tray
for settings, gestures, size, mute, hide/show, and quit. Ctrl+Alt+J summons chat.
The × beside the robot's menu and Alt+F4 quit the companion. Ctrl+Alt+Q is an
independent emergency quit shortcut; `stop_companion.bat` is also available.
See [desktop setup and verification](desktop-companion/README.md).

Speech currently uses system/browser speech synthesis and an approximate
animated mouth. Kokoro, phoneme lip sync, and avatar uploads remain future phases.

---

## Reliability update — 2 October 2026

File tools and the explorer now share one workspace service. Select an existing
directory; file access is confined to that selection, including resolved Windows
junctions. Credential files (`key.txt`, `aws_pass.txt`, `.env`) are excluded from
assistant access.

Creating text files or spreadsheets refuses to overwrite existing files. Editing
an existing text file requests approval with a diff, checks the reviewed content
hash, writes atomically, and stores the previous bytes in `.jarvis-backups/`.
Backups are recoverable manually and are excluded from assistant file access.

Each completed tool call is checkpointed before another approval can pause the
task. Approvals identify a specific call, and both browser and CLI support
successive approvals. Failed steps are reported explicitly. The API requires the
session cookie set when opening the root page, rejects untrusted hosts/origins,
and serializes mutations in this single-process deployment. Use one Uvicorn
worker; durable multi-session execution remains planned.

Chat Markdown permits text formatting and safe links; raw embedded HTML controls,
images, scripts, and event attributes are removed. The UI still uses CDN assets,
so fully offline frontend packaging remains planned. Whisper loads on the first
voice request rather than during server import.

Run offline regression checks with:

```powershell
python -m unittest discover -s tests -v
node --check web_ui/app.js
node --check web_ui/security.js
```

These tests use fake model responses and an isolated database stub, not your
credentials or personal chat history. Live model/microphone and browser-rendering
verification remain separate checks.

## 🌟 Key Features

* **🧠 LangGraph Multi-Step Reasoning Engine:** Iterative ReAct cycle that plans, calls tools sequentially, evaluates results, and accomplishes multi-step instructions autonomously.
* **⚡ Dual LLM Provider Support:**
  * **Ollama (Local Offline):** Runs locally on `qwen2.5:3b`, `qwen2.5-coder:7b`, or `gemma:2b` for complete privacy.
  * **Google Gemini (Cloud):** Fast cloud intelligence using `gemini-2.5-flash` via Google GenAI API.
  * **Startup reasoning choice:** Select Local or Cloud and a model at launch, or change the selection later through Settings.
* **📁 Dynamic Project Working Directory:** Anchor the assistant to any project folder on your computer. All files (`.py`, `.js`, `.json`, `.md`, `.txt`, `.xlsx`) and folders created by the agent are placed directly inside your chosen workspace.
* **🎙️ Local Faster-Whisper Speech Recognition:** Offline speech-to-text with microphone oscilloscope.
* **🛡️ Human-in-the-Loop Safety Gate:** Safe workspace operations run automatically, while high-risk actions (file deletion, opening apps) request explicit approval with conversational confirmation (`"yes"`, `"proceed"`).
* **💻 Minimal Chat Interface:** Light, Dark, and Warm themes; expanding composer; safe Markdown; collapsed activity per response. Files, provider settings, voice input, confirmed memory reset, and the optional robot companion open through the main menu (Ctrl+K).

---

## 🛠️ Registered Agent Tools (12 Tools)

| Tool Name | Description |
| :--- | :--- |
| `create_folder` | Creates directories and nested subfolders in the workspace. |
| `create_note` | Creates code/text files with extensions (`.py`, `.js`, `.json`, `.md`, `.txt`, etc.). |
| `read_note` | Reads content of any workspace file. |
| `modify_note` | Appends or search-and-replaces text in workspace files. |
| `delete_note` | Deletes workspace files (requires user approval). |
| `list_files` | Lists directory contents and files. |
| `create_excel` | Generates formatted Excel spreadsheets (`.xlsx`) with custom columns and rows. |
| `web_search` | Performs live web searches for current information and news. |
| `set_timer` | Sets background countdown timers. |
| `open_app` | Launches approved Windows desktop applications (requires user approval). |
| `get_time` | Fetches local system time. |
| `get_date` | Fetches today's date. |

---

## 🚀 Getting Started

### 1. Prerequisites
* **Python 3.10+** (Tested on Python 3.14 on Windows)
* **Ollama** (for local models): [Download Ollama](https://ollama.com/)
  ```bash
  ollama run qwen2.5:3b
  ```
* *(Optional)* **Gemini API Key** in `key.txt` or environment variable `GEMINI_API_KEY`.

### 2. Install Dependencies
```powershell
pip install -r requirements.txt
```

### 3. Run Jarvis
Launch the FastAPI Uvicorn server:
```powershell
python -m uvicorn web_server:app --host 127.0.0.1 --port 8000
```
*Or double-click `run_web.bat`.*

### 4. Open the Interface
Navigate to **[http://localhost:8000](http://localhost:8000)** in your web browser.

---

## 📂 Project Structure

```
├── command_framework/
│   ├── agent/
│   │   ├── __init__.py           # Package init exporting JarvisAgent
│   │   ├── agent_graph.py        # LangGraph StateGraph, ReAct cycle, and checkpointing
│   │   └── agent_tools.py        # 12 typed LangChain @tool wrappers
│   ├── modules/
│   │   ├── file_manager.py       # Dynamic workspace filesystem & developer file creation
│   │   ├── system_control.py     # Windows application launcher & date/time
│   │   ├── reminders.py          # Active countdown timer manager
│   │   └── web_search.py         # DuckDuckGo search integration
│   └── safety_guard.py           # Multi-tier security validator and approval rules
├── web_ui/
│   ├── index.html                # 3-Column Developer Mission Control layout
│   ├── style.css                 # Sleek dark theme stylesheet (Linear/Cursor aesthetic)
│   ├── app.js                    # UI controller, workspace manager, and activity timeline
│   └── space.js                  # Lightweight ambient canvas
├── config.json                   # LLM provider configuration (Ollama / Gemini)
├── database.py                   # SQLite chat and activity persistence
├── web_server.py                 # FastAPI backend server with full REST APIs
└── requirements.txt              # Project dependencies
```
