"""
agent_tools.py - LangChain Tool definitions for Jarvis Agent.
Exposes file operations, system controls, web search, notes, timers, and excel generation.
"""

from typing import List, Optional, Any
from langchain_core.tools import tool
from command_framework.modules.file_manager import FileManager
from command_framework.modules.system_control import SystemController
from command_framework.modules.reminders import ReminderManager
from command_framework.modules.web_search import WebSearcher

# Module singletons used by tools
_files = FileManager()
_system = SystemController()
_searcher = WebSearcher()
_reminders = ReminderManager(speak_callback=None)


def set_tool_working_dir(path: str):
    """Update working directory across file tools."""
    return _files.set_working_dir(path)


def get_file_manager():
    """The shared workspace service used by API and tool calls."""
    return _files


def get_tool_working_dir() -> str:
    """Get active working directory across file tools."""
    return _files.get_working_dir()


@tool
def create_folder(path: str) -> str:
    """Create a new folder/directory inside the project workspace.
    
    Args:
        path: Relative path for the new folder (e.g., 'research', 'docs/budget').
    """
    return _files.create_folder(path)


@tool
def create_note(filename: str, content: str, folder: str = "") -> str:
    """Create a file (e.g. .py, .txt, .json, .md, .js, .html) with the given code or text content in the project workspace or a specified subfolder.
    
    Args:
        filename: Name of the file with extension if applicable (e.g., 'reverse.py', 'summary.txt', 'script.js', 'data.json').
        content: The complete text or source code content to write into the file.
        folder: Optional subfolder path inside the workspace (e.g., 'python_folder', 'src', 'docs').
    """
    return _files.create_note(filename, content, folder=folder if folder else None)


@tool
def read_note(filename: str = "", folder: str = "") -> str:
    """Read the contents of a saved text file from the workspace. If filename is empty, reads the most recently modified file.
    
    Args:
        filename: Name of the file to read (optional).
        folder: Optional subfolder containing the file.
    """
    return _files.read_note(filename=filename, folder=folder if folder else None)


@tool
def modify_note(
    filename: str,
    find_text: str = "",
    replace_text: str = "",
    append_text: str = "",
    folder: str = "",
    expected_hash: Optional[str] = None
) -> str:
    """Modify an existing file in the workspace by appending text or finding and replacing specific text.
    
    Args:
        filename: Name of the file to modify.
        find_text: Text string to search for (optional).
        replace_text: Replacement text to swap in for find_text (optional).
        append_text: Text string to append at the end of the file (optional).
        folder: Optional subfolder containing the file.
        expected_hash: Optional SHA-256 of the reviewed original file.
    """
    return _files.modify_note(
        filename=filename,
        find_text=find_text if find_text else None,
        replace_text=replace_text,
        append_text=append_text if append_text else None,
        folder=folder if folder else None,
        expected_hash=expected_hash
    )


@tool
def delete_note(filename: str, folder: str = "") -> str:
    """Delete a file from the project workspace.
    
    Args:
        filename: Name of the file to delete.
        folder: Optional subfolder containing the file.
    """
    return _files.delete_note(filename=filename, folder=folder if folder else None)


@tool
def list_files(path: str = "") -> str:
    """List all files and subdirectories in a given folder of the workspace.
    
    Args:
        path: Path to the subfolder to list (optional, defaults to root workspace).
    """
    return _files.list_files(path)


@tool
def create_excel(filename: str, headers: List[str], rows: List[List[Any]], folder: str = "") -> str:
    """Create a formatted Excel (.xlsx) spreadsheet with columns and rows in the workspace.
    
    Args:
        filename: Name of the Excel file (e.g., 'budget', 'inventory').
        headers: List of column header strings (e.g., ['Item', 'Cost', 'Qty']).
        rows: List of row data lists (e.g., [['Apples', 5.0, 10], ['Oranges', 3.5, 6]]).
        folder: Optional subfolder in the workspace.
    """
    return _files.create_excel(filename, headers, rows, folder=folder if folder else None)


@tool
def web_search(query: str) -> str:
    """Perform a web search to find current information, answers, facts, or summaries.
    
    Args:
        query: Search keywords or question.
    """
    return _searcher.search(query)


@tool
def set_timer(seconds: int, message: str = "Timer finished!") -> str:
    """Set a countdown timer that alerts the user when the duration completes.
    
    Args:
        seconds: Countdown duration in seconds.
        message: Alert message to announce when the timer finishes.
    """
    try:
        sec_int = int(seconds)
    except Exception:
        sec_int = 10
    return _reminders.set_timer(sec_int, message)


@tool
def open_app(app: str) -> str:
    """Open an approved desktop application on the Windows host computer.
    
    Args:
        app: Application name (e.g., 'notepad', 'calculator', 'chrome', 'vscode', 'explorer').
    """
    return _system.open_app(app)


@tool
def get_time() -> str:
    """Get the current local time."""
    return _system.get_time()


@tool
def get_date() -> str:
    """Get today's date."""
    return _system.get_date()


# Complete list of available tools
ALL_TOOLS = [
    create_folder,
    create_note,
    read_note,
    modify_note,
    delete_note,
    list_files,
    create_excel,
    web_search,
    set_timer,
    open_app,
    get_time,
    get_date,
]

TOOL_MAP = {t.name: t for t in ALL_TOOLS}
