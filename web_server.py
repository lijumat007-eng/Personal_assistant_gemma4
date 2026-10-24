# web_server.py - FastAPI Backend for Jarvis Mission Control (LangGraph Powered)

import os
import sys
import json
import uuid
import wave
import logging
import asyncio
import copy
import requests
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Response, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, SecretStr
from typing import Dict, Any, List, Optional

# Import LangGraph agent and command modules
from command_framework.agent.agent_graph import JarvisAgent
from command_framework.agent.agent_tools import ALL_TOOLS, set_tool_working_dir, get_tool_working_dir, get_file_manager
from command_framework.modules.file_manager import FileManager
from command_framework.modules.reminders import ReminderManager
from command_framework.modules.system_control import SystemController
from faster_whisper import WhisperModel

# ---------------------------------------------------------------------------
# Setup logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("JarvisWebAPI")

# Generate secure session token on startup
SESSION_TOKEN = uuid.uuid4().hex
logger.info("=" * 60)
logger.info("Jarvis session authorization initialized.")
logger.info("=" * 60)

# ---------------------------------------------------------------------------
# Web Server Setup
# ---------------------------------------------------------------------------
app = FastAPI(title="Jarvis Web API", description="LangGraph Mission Control API server linking Celestial UI with Jarvis.")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])
mutation_lock = asyncio.Lock()


@app.middleware("http")
async def protect_active_run(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method in {"POST", "DELETE"}:
        if mutation_lock.locked():
            return JSONResponse(status_code=409, content={"detail": "An operation is already running."})
        async with mutation_lock:
            if request.url.path in {"/api/workspace", "/api/agent/config", "/api/agent/clear"}:
                snapshot = agent.graph.get_state({"configurable": {"thread_id": agent.active_thread_id}})
                if snapshot.next:
                    return JSONResponse(status_code=409, content={"detail": "Resolve the pending approval first."})
            return await call_next(request)
    return await call_next(request)


@app.exception_handler(OSError)
async def filesystem_error(request: Request, exc: OSError):
    code = 403 if isinstance(exc, PermissionError) else 404 if isinstance(exc, FileNotFoundError) else 409 if isinstance(exc, FileExistsError) else 500
    return JSONResponse(status_code=code, content={"status": "error", "detail": str(exc)})


@app.exception_handler(ValueError)
async def invalid_value(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"status": "error", "detail": str(exc)})

# Configure CORS restricted to localhost origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Content-Type", "X-Jarvis-Token"],
)

# Prevent caching for frontend files to guarantee immediate UI updates
@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    if not request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Secure verification dependency
async def verify_token(request: Request):
    """Require the actual session credential, including for same-origin requests."""
    origin = request.headers.get("Origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(status_code=403, detail="Cross-origin API requests are not allowed.")

    token_header = request.headers.get("X-Jarvis-Token")
    token_cookie = request.cookies.get("jarvis_token")
    if token_header == SESSION_TOKEN or token_cookie == SESSION_TOKEN:
        return True
    raise HTTPException(status_code=401, detail="Unauthorized: Invalid or missing secure session token.")

# Singletons
logger.info("Initializing LangGraph Multi-Step Reasoning Agent...")
agent = JarvisAgent(speak_callback=None)
file_mgr = get_file_manager()
reminder_mgr = ReminderManager(speak_callback=None)
system_ctrl = SystemController()
whisper_model = None

# Lazy load the Whisper model with GPU/CUDA fallback auto-detection
def get_whisper_model():
    global whisper_model
    if whisper_model is None:
        device = "cpu"
        compute_type = "int8"
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
                compute_type = "float16"
        except Exception:
            pass
        logger.info(f"Initializing Whisper model ('tiny' on {device.upper()} / {compute_type})...")
        whisper_model = WhisperModel("tiny", device=device, compute_type=compute_type)
        logger.info("Whisper model loaded.")
    return whisper_model

# Pre-load Whisper model to ensure immediate voice transcription response
logger.info("Whisper will load on the first voice request.")

# ---------------------------------------------------------------------------
# API Data Schemas
# ---------------------------------------------------------------------------
class QueryRequest(BaseModel):
    query: str

class ApprovalRequest(BaseModel):
    approval_id: str
    approved: bool

class AgentConfigRequest(BaseModel):
    provider: str
    model_name: Optional[str] = None
    api_key: Optional[SecretStr] = None

class WorkspaceRequest(BaseModel):
    path: str

class CreateFolderRequest(BaseModel):
    path: str

class CreateNoteRequest(BaseModel):
    filename: str
    content: str
    folder: Optional[str] = ""

# ---------------------------------------------------------------------------
# API Endpoints: Queries & Approvals
# ---------------------------------------------------------------------------

@app.post("/api/query", dependencies=[Depends(verify_token)])
async def run_query(req: QueryRequest):
    """Processes a text-based user command asynchronously via LangGraph Agent."""
    query_text = req.query.strip()
    if not query_text:
        return {"status": "error", "response": "Query was empty.", "steps": []}
        
    try:
        result = await asyncio.to_thread(agent.process_query, query_text)
        return result
    except Exception as e:
        logger.error(f"Error handling query: {e}", exc_info=True)
        return {"status": "error", "response": f"An internal server error occurred: {str(e)}", "steps": []}

@app.post("/api/approve", dependencies=[Depends(verify_token)])
async def handle_approval(req: ApprovalRequest):
    """Process user's YES/NO decision for a pending action and resume LangGraph state."""
    try:
        result = await asyncio.to_thread(agent.resume_approval, req.approval_id, req.approved)
        return result
    except Exception as e:
        logger.error(f"Error handling approval: {e}", exc_info=True)
        return {"status": "error", "response": f"An internal server error occurred: {str(e)}", "steps": []}

@app.post("/api/voice_query", dependencies=[Depends(verify_token)])
async def run_voice_query(file: UploadFile = File(...)):
    """Receives a 16kHz WAV audio upload, transcribes with Whisper, and processes with LangGraph."""
    temp_filename = f"temp_{uuid.uuid4().hex}.wav"
    
    try:
        with open(temp_filename, "wb") as buffer:
            content = await file.read()
            buffer.write(content)
            
        logger.info(f"Parsing uploaded audio file: {temp_filename}")
        with wave.open(temp_filename, 'rb') as wav_file:
            n_channels = wav_file.getnchannels()
            sampwidth = wav_file.getsampwidth()
            framerate = wav_file.getframerate()
            n_frames = wav_file.getnframes()
            
            raw_data = wav_file.readframes(n_frames)
            
            if sampwidth == 2:
                audio_np = np.frombuffer(raw_data, dtype=np.int16).astype(np.float32) / 32768.0
            elif sampwidth == 1:
                audio_np = (np.frombuffer(raw_data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported wave sample width: {sampwidth}")
                
            if n_channels > 1:
                audio_np = audio_np.reshape(-1, n_channels).mean(axis=1)
                
            if framerate != 16000:
                logger.warning(f"Audio uploaded at rate {framerate}Hz instead of recommended 16000Hz.")
                
        # Transcribe with faster-whisper in background thread
        model = get_whisper_model()
        segments, info = await asyncio.to_thread(model.transcribe, audio_np, beam_size=5)
        transcription_text = " ".join([segment.text for segment in segments]).strip()
        logger.info(f"Whisper transcription result: '{transcription_text}'")
        
        if not transcription_text:
            return {"status": "success", "response": "I couldn't hear anything. Please try speaking again.", "transcription": "", "steps": []}
            
        # Execute query via LangGraph in background thread
        result = await asyncio.to_thread(agent.process_query, transcription_text)
        result["transcription"] = transcription_text
        return result
        
    except Exception as e:
        logger.error(f"Error processing voice upload: {e}", exc_info=True)
        return {"status": "error", "response": f"Voice transcription pipeline failed: {str(e)}", "steps": []}
        
    finally:
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except OSError as ex:
                logger.warning(f"Could not remove temp file {temp_filename}: {ex}")

# ---------------------------------------------------------------------------
# Workspace Project Directory Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/workspace", dependencies=[Depends(verify_token)])
async def get_workspace():
    """Get active workspace project directory path."""
    current_dir = file_mgr.get_working_dir()
    return {
        "status": "success",
        "working_dir": current_dir,
        "root_name": os.path.basename(current_dir) or "workspace",
        "project_root": file_mgr.project_root
    }

@app.post("/api/workspace", dependencies=[Depends(verify_token)])
async def set_workspace(req: WorkspaceRequest):
    """Set active workspace project directory and sync with agent tools."""
    new_dir = file_mgr.set_working_dir(req.path)
    set_tool_working_dir(new_dir)
    logger.info(f"Active workspace directory updated to: {new_dir}")
    return {
        "status": "success",
        "working_dir": new_dir,
        "root_name": os.path.basename(new_dir) or "workspace",
        "message": f"Workspace set to '{new_dir}'"
    }

# ---------------------------------------------------------------------------
# Agent Management Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/agent/status", dependencies=[Depends(verify_token)])
async def get_agent_status():
    """Returns real-time agent status, active provider, model name, and tool capabilities."""
    tools_info = [{"name": t.name, "description": (t.description or "").split("\n")[0]} for t in ALL_TOOLS]
    return {
        "status": "success",
        "provider": agent.provider,
        "model_name": agent.model_name,
        "ollama_host": agent.ollama_host,
        "workspace": file_mgr.get_working_dir(),
        "tools": tools_info,
        "tool_count": len(ALL_TOOLS),
        "active": True
    }

@app.post("/api/agent/config", dependencies=[Depends(verify_token)])
async def update_agent_config(req: AgentConfigRequest):
    """Apply a model atomically, keeping new credentials in server memory only."""
    new_provider = req.provider.lower()
    if new_provider not in ("ollama", "gemini"):
        raise HTTPException(status_code=400, detail="Invalid provider. Choose 'ollama' or 'gemini'.")
        
    try:
        config_path = agent.config_path
        config = {}
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
                
        model_name = (req.model_name or config.get(new_provider, {}).get("model_name", "")).strip()
        if not model_name or len(model_name) > 200:
            raise HTTPException(status_code=400, detail="Choose a valid model name.")
        candidate = copy.copy(agent)
        candidate.provider = new_provider
        candidate.model_name = model_name
        candidate.ollama_host = config.get("ollama", {}).get("host", "http://localhost:11434")
        if new_provider == "ollama":
            installed = await asyncio.to_thread(ollama_models, candidate.ollama_host)
            if model_name not in {item["name"] for item in installed}:
                raise HTTPException(status_code=400, detail="That model is not installed in Ollama. Refresh the list.")
        else:
            new_key = req.api_key.get_secret_value().strip() if req.api_key else ""
            candidate.api_key = new_key or agent.api_key
            if not candidate.api_key:
                raise HTTPException(status_code=400, detail="Enter a Gemini API key to use Cloud.")
        await asyncio.to_thread(candidate._init_models)
        if candidate.llm is None:
            raise HTTPException(status_code=400, detail="Could not initialize the selected provider. Check its settings and dependencies.")
        config["llm_provider"] = new_provider
        config.setdefault(new_provider, {})["model_name"] = model_name
        temporary = config_path + ".tmp"
        try:
            with open(temporary, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
            os.replace(temporary, config_path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
        for name in ("provider", "model_name", "ollama_host", "api_key", "llm", "fallback_llm"):
            setattr(agent, name, getattr(candidate, name))
        logger.info(f"Agent provider switched to '{new_provider}' (Model: {agent.model_name})")
        
        return {
            "status": "success",
            "provider": agent.provider,
            "model_name": agent.model_name,
            "message": f"Switched LLM provider to {new_provider.upper()} ({agent.model_name})"
        }
    except HTTPException:
        raise
    except Exception:
        logger.error("Failed to update agent configuration.")
        raise HTTPException(status_code=500, detail="Could not save reasoning settings. Your previous configuration is still active.")


def ollama_models(host):
    """Read installed models from the configured Ollama instance."""
    try:
        response = requests.get(host.rstrip("/") + "/api/tags", timeout=5)
        response.raise_for_status()
        data = response.json()
        return sorted([{"name": item["name"], "size": item.get("size", 0)}
                       for item in data["models"] if isinstance(item.get("name"), str)],
                      key=lambda item: item["name"].lower())
    except (requests.RequestException, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(status_code=503, detail="Cannot connect to Ollama. Start Ollama, then refresh the model list.")


@app.get("/api/agent/models", dependencies=[Depends(verify_token)])
async def get_ollama_models():
    with open(agent.config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    host = config.get("ollama", {}).get("host", "http://localhost:11434")
    return {"models": await asyncio.to_thread(ollama_models, host)}


@app.get("/api/agent/options", dependencies=[Depends(verify_token)])
async def get_reasoning_options():
    with open(agent.config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    return {"provider": agent.provider, "model_name": agent.model_name,
            "local_model": config.get("ollama", {}).get("model_name", ""),
            "cloud_model": config.get("gemini", {}).get("model_name", "gemini-2.5-flash"),
            "cloud_key_configured": bool(agent.api_key)}

@app.post("/api/agent/clear", dependencies=[Depends(verify_token)])
async def clear_agent_memory():
    """Resets memory checkpointer thread state for a clean slate."""
    try:
        from langgraph.checkpoint.memory import MemorySaver
        agent.checkpointer = MemorySaver()
        agent._build_graph()
        return {"status": "success", "message": "Agent conversation memory cleared."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear memory: {e}")

# ---------------------------------------------------------------------------
# File & Folder Explorer Endpoints (Recursive Dynamic Tree)
# ---------------------------------------------------------------------------

def _build_dir_tree(base_path: str, rel_path: str = "", depth: int = 0) -> List[Dict[str, Any]]:
    """Helper to build recursive file tree structure up to safe depth."""
    items = []
    if depth > 8:
        return items
        
    current_dir = os.path.join(base_path, rel_path) if rel_path else base_path
    if not os.path.exists(current_dir):
        return items

    try:
        entries = sorted(os.listdir(current_dir), key=lambda x: (not os.path.isdir(os.path.join(current_dir, x)), x.lower()))
        for entry in entries:
            # Skip hidden files, system folders, or node_modules
            if entry.startswith(".") or entry in ("__pycache__", "node_modules", "venv", ".git"):
                continue
            full_entry = os.path.join(current_dir, entry)
            if not file_mgr._is_within_project(full_entry) or os.path.islink(full_entry) or (hasattr(os.path, "isjunction") and os.path.isjunction(full_entry)):
                continue
            if entry.lower() in {"key.txt", "aws_pass.txt", ".env"}:
                continue
            entry_rel = os.path.join(rel_path, entry).replace("\\", "/") if rel_path else entry
            
            if os.path.isdir(full_entry):
                sub_children = _build_dir_tree(base_path, entry_rel, depth + 1)
                items.append({
                    "name": entry,
                    "path": entry_rel,
                    "is_dir": True,
                    "children": sub_children,
                    "item_count": len(sub_children)
                })
            else:
                stat = os.stat(full_entry)
                ext = entry.split(".")[-1].lower() if "." in entry else "file"
                items.append({
                    "name": entry,
                    "path": entry_rel,
                    "is_dir": False,
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                    "type": ext
                })
    except Exception as e:
        logger.error(f"Error scanning directory {current_dir}: {e}")
        
    return items

@app.get("/api/explorer", dependencies=[Depends(verify_token)])
async def get_file_explorer():
    """Returns a full recursive tree of the active workspace directory."""
    try:
        active_dir = file_mgr.get_working_dir()
        tree = _build_dir_tree(active_dir)
        
        # Calculate summary metrics safely
        total_files = 0
        total_dirs = 0
        for root, dirs, files in os.walk(active_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("__pycache__", "node_modules", "venv", ".git")
                       and not os.path.islink(os.path.join(root, d))
                       and not (hasattr(os.path, "isjunction") and os.path.isjunction(os.path.join(root, d)))
                       and file_mgr._is_within_project(os.path.join(root, d))]
            total_dirs += len(dirs)
            total_files += sum(1 for f in files if not f.startswith(".") and f.lower() not in {"key.txt", "aws_pass.txt"})
        
        return {
            "status": "success",
            "root_name": os.path.basename(active_dir) or "workspace",
            "root_path": active_dir,
            "tree": tree,
            "total_files": total_files,
            "total_dirs": total_dirs
        }
    except Exception as e:
        logger.error(f"Failed to generate explorer tree: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/explorer/create_folder", dependencies=[Depends(verify_token)])
async def create_explorer_folder(req: CreateFolderRequest):
    """Directly creates a folder in the active workspace."""
    result = file_mgr.create_folder(req.path)
    return {"status": "success", "message": result}

@app.post("/api/explorer/create_note", dependencies=[Depends(verify_token)])
async def create_explorer_note(req: CreateNoteRequest):
    """Directly creates a file in the active workspace."""
    result = file_mgr.create_note(req.filename, req.content, folder=req.folder)
    return {"status": "success", "message": result}

# ---------------------------------------------------------------------------
# Note Read & Delete Endpoints (Relative to Active Workspace)
# ---------------------------------------------------------------------------

@app.get("/api/notes/{filename:path}", dependencies=[Depends(verify_token)])
async def read_note(filename: str):
    """Reads a specific file from the active workspace."""
    try:
        folder = os.path.dirname(filename)
        base_name = os.path.basename(filename)
        result = await asyncio.to_thread(file_mgr.read_note, base_name, folder=folder if folder else None)
        if result.startswith("Access to that path") or result.startswith("I couldn't find"):
            raise HTTPException(status_code=400, detail=result)
        return {"status": "success", "content": result}
    except (OSError, ValueError, HTTPException):
        raise

@app.delete("/api/notes/{filename:path}", dependencies=[Depends(verify_token)])
async def delete_note(filename: str):
    """Deletes a file from the active workspace."""
    try:
        folder = os.path.dirname(filename)
        base_name = os.path.basename(filename)
        result = await asyncio.to_thread(file_mgr.delete_note, base_name, folder=folder if folder else None)
        return {"status": "success", "message": result}
    except (OSError, ValueError, HTTPException):
        raise

# ---------------------------------------------------------------------------
# Timers API
# ---------------------------------------------------------------------------

@app.get("/api/timers", dependencies=[Depends(verify_token)])
async def list_active_timers():
    """Returns list of active reminders."""
    return reminder_mgr.list_timers()

@app.delete("/api/timers/{timer_id}", dependencies=[Depends(verify_token)])
async def cancel_timer(timer_id: str):
    """Cancels an active timer."""
    success = reminder_mgr.cancel_timer(timer_id)
    if success:
        return {"status": "success", "message": f"Timer {timer_id} cancelled."}
    raise HTTPException(status_code=404, detail="Timer not found or already completed.")

# ---------------------------------------------------------------------------
# Serve Index Page (Sets Cookie)
# ---------------------------------------------------------------------------
ui_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_ui")

@app.get("/")
async def get_index():
    """Root route that sets the secure authorization cookie and serves index.html."""
    index_file = os.path.join(ui_dir, "index.html")
    if os.path.exists(index_file):
        response = FileResponse(index_file)
    else:
        response = Response(content='{"message": "Jarvis Mission Control UI ready. Open index.html directly."}', media_type="application/json")
        
    response.set_cookie(
        key="jarvis_token",
        value=SESSION_TOKEN,
        httponly=True,
        samesite="strict",
        max_age=3600 * 24 # 1 day expiration
    )
    return response

# ---------------------------------------------------------------------------
# Mount Static Files
# ---------------------------------------------------------------------------
if os.path.exists(ui_dir):
    logger.info(f"Mounting static files from directory: {ui_dir}")
    app.mount("/", StaticFiles(directory=ui_dir), name="static")
else:
    logger.warning(f"Static directory '{ui_dir}' was not found. API routes are active, but frontend will not serve.")
