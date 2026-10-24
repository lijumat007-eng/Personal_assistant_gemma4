"""
agent_graph.py - LangGraph Multi-Step Reasoning Engine for Jarvis.
Implements a stateful ReAct cycle with tool execution, safety checks,
human-in-the-loop interrupts, and thread persistence.
"""

import os
import sys
import json
import uuid
import logging
import hashlib
import difflib
from typing import Annotated, Sequence, TypedDict, Optional, List, Dict, Any

from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    AIMessage,
    ToolMessage,
    SystemMessage,
)
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command

# Root path resolution for database and modules
_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_MODULE_DIR, "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import database
from command_framework import safety_guard
from command_framework.agent.agent_tools import ALL_TOOLS, TOOL_MAP

logger = logging.getLogger("JarvisAgent")

# ─────────────────────────────────────────────────────────────────────────────
# System Prompt for Multi-Step Autonomous Reasoning
# ─────────────────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """\
You are Jarvis, an advanced, highly intelligent desktop AI agent running on Windows.
You have access to a set of specialized tools for file management, code generation, system controls, web search, timers, and data operations.

CRITICAL RULES FOR AUTONOMOUS MULTI-STEP REASONING:
1. When the user gives a multi-step instruction (such as "create a folder X, and create a python file with program Y"):
   - Decompose the request into logical tool calls.
   - Execute the first tool call immediately (e.g. create_folder).
   - Once the tool result is received, immediately call the next tool (e.g. create_note) with the requested code/content.
   - Continue calling tools until EVERY requested file, folder, search, or modification is completely finished.
   - Do NOT stop after just 1 step to ask the user if you should proceed. You are authorized to complete all steps autonomously.
   - Only produce your final user-facing response when ALL requested actions have been executed.
2. For coding requests (e.g. Python, JavaScript, HTML, JSON):
   - Call `create_note` with the full filename (e.g. `reverse.py`, `app.js`, `data.json`) and write complete, working source code.
3. For simple conversations or queries, answer directly and concisely without tool calls.
4. When finished, provide a concise, polite summary of what was created and where.
"""

# ─────────────────────────────────────────────────────────────────────────────
# State Schema
# ─────────────────────────────────────────────────────────────────────────────
class StepRecord(TypedDict):
    step: int
    tool: str
    args: Dict[str, Any]
    result: str
    status: str

class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]
    steps: List[StepRecord]
    current_step: int
    pending_tools: List[Dict[str, Any]]
    approval_preview: str


# ─────────────────────────────────────────────────────────────────────────────
# JarvisAgent Class
# ─────────────────────────────────────────────────────────────────────────────
class JarvisAgent:
    def __init__(self, speak_callback=None):
        self.speak_callback = speak_callback
        self.config_path = os.path.join(_PROJECT_ROOT, "config.json")
        self.provider = "ollama"
        self.model_name = "qwen2.5:3b"
        self.ollama_host = "http://localhost:11434"
        self.api_key = os.environ.get("GEMINI_API_KEY", "")
        self.active_thread_id = str(uuid.uuid4())
        
        self._load_config()
        self._init_models()
        self._build_graph()

    def _load_config(self):
        """Read configuration from config.json."""
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
                    self.provider = config.get("llm_provider", "ollama")
                    if self.provider == "gemini":
                        self.model_name = config.get("gemini", {}).get("model_name", "gemini-2.5-flash")
                    else:
                        self.model_name = config.get("ollama", {}).get("model_name", "qwen2.5:3b")
                        self.ollama_host = config.get("ollama", {}).get("host", "http://localhost:11434")
            except Exception as e:
                logger.error(f"Error loading config.json: {e}")

        # Check key.txt for Gemini key fallback
        if not self.api_key:
            key_txt_path = os.path.join(_PROJECT_ROOT, "key.txt")
            if os.path.exists(key_txt_path):
                try:
                    with open(key_txt_path, "r", encoding="utf-8") as f:
                        self.api_key = f.read().strip()
                        if self.api_key:
                            os.environ["GEMINI_API_KEY"] = self.api_key
                except Exception as e:
                    logger.error(f"Error reading key.txt: {e}")

    def _init_models(self):
        """Initialize only the selected reasoning provider with tool bindings."""
        self.llm = None
        self.fallback_llm = None

        # Cloud is used only when explicitly selected.
        gemini_model = None
        if self.provider == "gemini" and self.api_key:
            try:
                from langchain_google_genai import ChatGoogleGenerativeAI
                gemini_model = ChatGoogleGenerativeAI(
                    model=self.model_name,
                    api_key=self.api_key,
                    temperature=0.2,
                ).bind_tools(ALL_TOOLS)
                logger.info("Initialized configured Gemini model with tools.")
            except Exception as e:
                logger.warning("Could not initialize Gemini model.")

        # Primary provider selection
        if self.provider == "ollama":
            try:
                from langchain_ollama import ChatOllama
                self.llm = ChatOllama(
                    model=self.model_name,
                    base_url=self.ollama_host,
                    temperature=0.2,
                ).bind_tools(ALL_TOOLS)
                logger.info(f"Initialized Ollama model '{self.model_name}' at {self.ollama_host}.")
            except Exception as e:
                logger.warning("Ollama initialization failed.")
        else:
            self.llm = gemini_model

        if self.llm is None and gemini_model is not None:
            self.llm = gemini_model

    def _build_graph(self):
        """Construct the LangGraph StateGraph with checkpointing."""
        workflow = StateGraph(AgentState)

        # Nodes
        workflow.add_node("agent", self._agent_node)
        workflow.add_node("tools", self._tool_node)
        workflow.add_node("prepare", self._prepare_tool)
        workflow.add_edge("prepare", "tools")

        # Edges
        workflow.set_entry_point("agent")
        workflow.add_conditional_edges(
            "agent",
            self._should_continue,
            {
                "tools": "prepare",
                "end": END,
            }
        )
        workflow.add_conditional_edges("tools", self._after_tool, {"tools": "prepare", "agent": "agent"})

        # In-memory checkpointer for thread history and interrupts
        self.checkpointer = MemorySaver()
        self.graph = workflow.compile(checkpointer=self.checkpointer)
        logger.info("Jarvis LangGraph StateGraph compiled successfully.")

    # ── Node Implementations ──────────────────────────────────────────────────
    def _agent_node(self, state: AgentState) -> Dict[str, Any]:
        """Invoke the LLM with messages and bound tools."""
        messages = list(state.get("messages", []))
        
        # Ensure system prompt with dynamic workspace directory is present
        from command_framework.agent.agent_tools import get_tool_working_dir
        workspace_dir = get_tool_working_dir()
        full_sys_prompt = (
            f"{SYSTEM_PROMPT}\n"
            f"ACTIVE PROJECT WORKSPACE:\n"
            f"All file and folder operations must occur directly inside: '{workspace_dir}'.\n"
            f"When creating notes or spreadsheets, save them inside this workspace or requested subfolders."
        )
        
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=full_sys_prompt)] + messages
        else:
            messages[0] = SystemMessage(content=full_sys_prompt)

        try:
            response = self.llm.invoke(messages)
        except Exception as primary_err:
            logger.warning(f"Primary model error: {primary_err}")
            if self.fallback_llm:
                logger.info("Attempting Gemini fallback...")
                response = self.fallback_llm.invoke(messages)
            else:
                raise primary_err

        return {"messages": [response], "pending_tools": list(response.tool_calls or [])}

    def _tool_node(self, state: AgentState) -> Dict[str, Any]:
        """Execute tool calls, validate safety, handle approvals, and record step traces."""
        tool_calls = state.get("pending_tools", [])
        
        steps = list(state.get("steps", []))
        current_step = state.get("current_step", len(steps))
        new_messages = []

        # A completed call is checkpointed before the next call can interrupt.
        for tc in tool_calls[:1]:
            current_step += 1
            tool_name = tc["name"]
            tool_args = tc.get("args", {})
            call_id = tc.get("id", str(uuid.uuid4()))

            logger.info(f"[Step {current_step}] Tool Call: {tool_name} with args {tool_args}")

            # 1. Safety Guard Validation
            is_safe, block_reason = safety_guard.validate(tool_name, tool_args)
            if not is_safe:
                err_msg = f"[BLOCKED by Safety Guard]: {block_reason}"
                logger.warning(f"Tool '{tool_name}' blocked: {block_reason}")
                steps.append({
                    "step": current_step,
                    "tool": tool_name,
                    "args": tool_args,
                    "result": err_msg,
                    "status": "blocked",
                })
                new_messages.append(ToolMessage(content=err_msg, tool_call_id=call_id))
                continue

            # 2. Approval Check (Human-in-the-Loop Interrupt)
            if tool_name in safety_guard.APPROVAL_REQUIRED:
                action_desc = self._describe_tool_action(tool_name, tool_args)
                if state.get("approval_preview"):
                    action_desc += "\n" + state["approval_preview"]
                logger.info(f"Action '{tool_name}' requires approval: {action_desc}")

                # Trigger LangGraph interrupt - pauses graph and yields approval payload
                approval_payload = {
                    "action": tool_name,
                    "params": tool_args,
                    "description": action_desc,
                    "step": current_step,
                    "call_id": call_id,
                }
                user_approved = interrupt(approval_payload)

                if not user_approved:
                    denied_msg = f"Action '{tool_name}' was cancelled by user."
                    logger.info(f"User denied tool execution: {tool_name}")
                    steps.append({
                        "step": current_step,
                        "tool": tool_name,
                        "args": tool_args,
                        "result": denied_msg,
                        "status": "denied",
                    })
                    new_messages.append(ToolMessage(content=denied_msg, tool_call_id=call_id))
                    continue

            # 3. Execute Tool
            tool_fn = TOOL_MAP.get(tool_name)
            tool_status = "success"
            if not tool_fn:
                res_str = f"Error: Tool '{tool_name}' not found."
                tool_status = "failed"
            else:
                try:
                    result = tool_fn.invoke(tool_args)
                    res_str = str(result)
                except Exception as e:
                    logger.error(f"Error executing tool '{tool_name}': {e}", exc_info=True)
                    res_str = f"Error executing {tool_name}: {str(e)}"
                    tool_status = "failed"

            steps.append({
                "step": current_step,
                "tool": tool_name,
                "args": tool_args,
                "result": res_str,
                "status": tool_status,
            })
            new_messages.append(ToolMessage(content=res_str, tool_call_id=call_id))

        return {
            "messages": new_messages,
            "steps": steps,
            "current_step": current_step,
            "pending_tools": tool_calls[1:],
        }

    def _prepare_tool(self, state: AgentState) -> Dict[str, Any]:
        """Checkpoint the original hash and preview before approval can pause."""
        calls = [dict(call) for call in state.get("pending_tools", [])]
        preview = ""
        if calls and calls[0]["name"] == "modify_note":
            from command_framework.agent.agent_tools import get_file_manager
            args = dict(calls[0].get("args", {}))
            target = get_file_manager()._file(args["filename"], args.get("folder"))
            original = target.read_bytes()
            args["expected_hash"] = hashlib.sha256(original).hexdigest()
            before = original.decode("utf-8")
            after = before
            if args.get("find_text"):
                after = after.replace(args["find_text"], args.get("replace_text", ""))
            if args.get("append_text"):
                after += ("\n" if after and not after.endswith("\n") else "") + args["append_text"]
            preview = "".join(difflib.unified_diff(before.splitlines(keepends=True),
                              after.splitlines(keepends=True), fromfile="original", tofile="proposed"))
            calls[0]["args"] = args
        return {"pending_tools": calls, "approval_preview": preview}

    def _after_tool(self, state: AgentState) -> str:
        return "tools" if state.get("pending_tools") else "agent"

    def _should_continue(self, state: AgentState) -> str:
        """Route to tools node if tool calls are present, otherwise finish."""
        last_message = state["messages"][-1]
        tool_calls = getattr(last_message, "tool_calls", None)
        if tool_calls and len(tool_calls) > 0:
            return "tools"
        return "end"

    def _describe_tool_action(self, tool_name: str, args: Dict[str, Any]) -> str:
        """Generate human-readable summary for approval prompts."""
        content = args.get("content", "")
        content_preview = (content[:80] + "…") if len(content) > 80 else content

        descriptions = {
            "open_app":      f"Open application: {args.get('app', '?')}",
            "create_note":   f"Create note '{args.get('filename', 'untitled')}.txt' in folder '{args.get('folder', 'notes')}' with content: \"{content_preview}\"",
            "modify_note":   f"Modify note '{args.get('filename', 'untitled')}.txt' in folder '{args.get('folder', 'notes')}'",
            "delete_note":   f"Delete note '{args.get('filename', '')}.txt' from folder '{args.get('folder', 'notes')}'",
            "create_folder": f"Create folder at: '{args.get('path', '?')}'",
            "create_excel":  f"Create Excel file '{args.get('filename', 'untitled')}.xlsx' with headers {args.get('headers', [])}",
            "set_timer":     f"Set timer for {args.get('seconds', '?')} seconds (Alert: \"{args.get('message', '')}\")",
        }
        return descriptions.get(tool_name, f"Execute '{tool_name}' with parameters {args}")

    # ── High Level Public API ────────────────────────────────────────────────
    def process_query(self, text: str, thread_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute a user query through the multi-step LangGraph agent.
        Returns a dict with:
          - status: 'success', 'pending_approval', 'blocked', or 'error'
          - response: final answer or description
          - steps: list of executed intermediate steps
          - thread_id: session thread ID
          - approval_id / description (if pending_approval)
        """
        if not text.strip():
            return {"status": "error", "response": "Query was empty.", "steps": []}

        if not thread_id:
            thread_id = self.active_thread_id

        snapshot = self.graph.get_state({"configurable": {"thread_id": thread_id}})
        if snapshot.next:
            return {"status": "error", "response": "Resolve the pending approval before starting another query.", "steps": []}

        database.add_chat_message("user", text)
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}

        initial_state = {
            "messages": [HumanMessage(content=text)],
            "steps": [],
            "current_step": 0,
            "pending_tools": [],
        }

        try:
            # Run graph until completion or interrupt
            final_state = self.graph.invoke(initial_state, config=config)

            # Check if execution was interrupted for approval
            state_snapshot = self.graph.get_state(config)
            if state_snapshot.next and state_snapshot.tasks:
                for task in state_snapshot.tasks:
                    if hasattr(task, "interrupts") and task.interrupts:
                        interrupt_val = task.interrupts[0].value
                        return {
                            "status": "pending_approval",
                            "approval_id": thread_id + ":" + interrupt_val["call_id"],
                            "thread_id": thread_id,
                            "description": interrupt_val.get("description", "Action requires your approval."),
                            "action": interrupt_val.get("action", ""),
                            "params": interrupt_val.get("params", {}),
                            "steps": final_state.get("steps", []),
                        }

            # Normal completion
            last_msg = final_state["messages"][-1]
            response_text = last_msg.content if isinstance(last_msg.content, str) else str(last_msg.content)
            
            failed = [step for step in final_state.get("steps", []) if step.get("status") == "failed"]
            if failed:
                response_text = "Some actions failed: " + "; ".join(step["result"] for step in failed) + "\n\n" + response_text
            database.add_chat_message("jarvis", response_text)
            return {
                "status": "error" if any(s.get("status") == "failed" for s in final_state.get("steps", [])) else "success",
                "response": response_text,
                "steps": final_state.get("steps", []),
                "thread_id": thread_id,
            }

        except Exception as e:
            logger.error(f"Error in JarvisAgent process_query: {e}", exc_info=True)
            err_msg = f"An error occurred while reasoning: {str(e)}"
            database.add_chat_message("jarvis", err_msg)
            return {
                "status": "error",
                "response": err_msg,
                "steps": [],
                "thread_id": thread_id,
            }

    def resume_approval(self, approval_id: str, approved: bool) -> Dict[str, Any]:
        """Resume only the specific pending call represented by this approval ID."""
        thread_id, separator, call_id = approval_id.rpartition(":")
        if not separator or thread_id != self.active_thread_id:
            return {"status": "error", "response": "Invalid approval ID.", "steps": []}
        config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 100}

        try:
            snapshot = self.graph.get_state(config)
            pending = [item.value for task in snapshot.tasks for item in getattr(task, "interrupts", ())]
            if not pending or pending[0].get("call_id") != call_id:
                return {"status": "error", "response": "Approval expired or already processed.", "steps": []}
            # Resume graph with approval boolean
            final_state = self.graph.invoke(Command(resume=approved), config=config)

            # Check if another interrupt occurred
            state_snapshot = self.graph.get_state(config)
            if state_snapshot.next and state_snapshot.tasks:
                for task in state_snapshot.tasks:
                    if hasattr(task, "interrupts") and task.interrupts:
                        interrupt_val = task.interrupts[0].value
                        return {
                            "status": "pending_approval",
                            "approval_id": thread_id + ":" + interrupt_val["call_id"],
                            "thread_id": thread_id,
                            "description": interrupt_val.get("description", "Action requires your approval."),
                            "action": interrupt_val.get("action", ""),
                            "params": interrupt_val.get("params", {}),
                            "steps": final_state.get("steps", []),
                        }

            last_msg = final_state["messages"][-1]
            response_text = last_msg.content if isinstance(last_msg.content, str) else str(last_msg.content)

            failed = [step for step in final_state.get("steps", []) if step.get("status") == "failed"]
            if failed:
                response_text = "Some actions failed: " + "; ".join(step["result"] for step in failed) + "\n\n" + response_text
            database.add_chat_message("jarvis", response_text)
            return {
                "status": "error" if any(s.get("status") == "failed" for s in final_state.get("steps", [])) else "success",
                "response": response_text,
                "steps": final_state.get("steps", []),
                "thread_id": thread_id,
            }
        except Exception as e:
            logger.error(f"Error resuming graph for thread {thread_id}: {e}", exc_info=True)
            err_msg = f"Error resuming execution: {str(e)}"
            return {
                "status": "error",
                "response": err_msg,
                "steps": [],
                "thread_id": thread_id,
            }
