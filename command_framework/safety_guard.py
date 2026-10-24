"""
safety_guard.py — Jarvis Security Layer

All LLM decisions pass through here before execution.
Enforces:
  - Action allowlist (only known safe actions can run)
  - Dangerous content scanning (shell/code injection patterns)
  - Protected path enforcement (system directories are off-limits)
  - App allowlist (only approved applications can be opened)
"""

import re
import os
import logging

# ── Action allowlist ──────────────────────────────────────────────────────────
# ONLY actions listed here will ever be dispatched. Anything else is rejected.
ALLOWED_ACTIONS = {
    "open_app",
    "get_time",
    "get_date",
    "create_note",
    "read_note",
    "modify_note",
    "delete_note",
    "create_folder",
    "create_excel",
    "list_files",
    "set_timer",
    "chat",
    "web_search",
}

# ── Approval tiers ────────────────────────────────────────────────────────────
# Safe workspace operations & informational queries — auto-approved for autonomous multi-step reasoning
AUTO_APPROVED = {
    "get_time",
    "get_date",
    "read_note",
    "list_files",
    "chat",
    "web_search",
    "create_note",
    "create_folder",
    "create_excel",
    "set_timer",
}

# High-risk / destructive actions — require explicit human-in-the-loop user approval
APPROVAL_REQUIRED = {
    "modify_note",
    "delete_note",
    "open_app",
}

# ── Approved applications ─────────────────────────────────────────────────────
# Only these apps may be opened via open_app. Any unlisted app is rejected.
ALLOWED_APPS = {
    "notepad", "calculator", "browser", "chrome",
    "explorer", "file explorer",
    "cmd", "terminal", "command prompt",
    "vscode", "vs code",
    "word", "excel", "powerpoint",
    "paint", "task manager", "control panel",
    "settings", "snipping tool",
}

# ── Dangerous content patterns ────────────────────────────────────────────────
# Scanned across ALL string parameters returned by the LLM.
_DANGEROUS_PATTERNS = [
    r"rm\s+[\-/]",              # rm -rf / rm /f
    r"del\s+/[sf]",             # del /s /f
    r"format\s+[a-zA-Z]:",      # format C:
    r"rmdir\s+/[sq]",           # rmdir /s /q
    r"rd\s+/[sq]",              # rd /s /q
    r"shutdown\s+/",            # shutdown /r /s /f
    r"reg\s+(delete|add|import|export)",  # registry manipulation
    r"netsh\s+",                # network config changes
    r"bcdedit",                 # boot configuration editor
    r"diskpart",                # disk partitioning tool
    r"sfc\s+/",                 # system file checker
    r"dism\s+/",                # deployment imaging tool
    r"powershell\s+(-e|-enc|-command|-nop)",  # encoded / command powershell
    r"cmd(\.exe)?\s+/[ck]",     # cmd /c or /k injection
    r"wscript|cscript",         # Windows scripting host
    r"mshta",                   # HTML application host
    r"regsvr32",                # register malicious DLLs
    r"certutil\s+-decode",      # certutil decode (common dropper technique)
    r"bitsadmin",               # background intelligent transfer
    r"os\.system\s*\(",         # Python os.system injection
    r"subprocess\.",            # Python subprocess injection
    r"eval\s*\(",               # eval injection
    r"exec\s*\(",               # exec injection
    r"__import__\s*\(",         # dynamic import bypass
    r"compile\s*\(",            # code compilation
    r"drop\s+table",            # SQL DROP TABLE
    r"truncate\s+table",        # SQL TRUNCATE
    r"delete\s+from",           # SQL DELETE
    r"grant\s+all",             # SQL privilege escalation
    r"xp_cmdshell",             # SQL Server shell execution
]
_COMPILED = [re.compile(p, re.IGNORECASE) for p in _DANGEROUS_PATTERNS]

# ── Protected filesystem paths ────────────────────────────────────────────────
# Jarvis will refuse to create files/folders in these locations.
_system_root = os.environ.get("SYSTEMROOT", "C:\\Windows").lower()
_win_dir = os.environ.get("WINDIR", "C:\\Windows").lower()

PROTECTED_PATHS = {
    _system_root,
    _win_dir,
    "c:\\windows",
    "c:\\windows\\system32",
    "c:\\windows\\syswow64",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata\\microsoft",
    "c:\\users\\default",
    "c:\\boot",
    "c:\\recovery",
}


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _first_dangerous_match(text):
    """Return the first dangerous pattern found in `text`, or None."""
    for pattern in _COMPILED:
        m = pattern.search(str(text))
        if m:
            return m.group()
    return None


def _scan_params(params):
    """
    Recursively scan all string values in a params dict for dangerous content.
    Returns (True, match_str) if something dangerous is found, else (False, None).
    """
    if isinstance(params, dict):
        for key, value in params.items():
            found, hit = _scan_params(value)
            if found:
                return True, f"param '{key}' contains '{hit}'"
    elif isinstance(params, list):
        for item in params:
            found, hit = _scan_params(item)
            if found:
                return True, hit
    elif isinstance(params, str):
        hit = _first_dangerous_match(params)
        if hit:
            return True, hit
    return False, None


def _is_protected_path(path):
    """
    Return True if `path` resolves into a protected system directory.

    Uses os.path.abspath so that relative traversal sequences like
    '..\\..\\Windows\\System32' are expanded to their true absolute
    path before being compared against PROTECTED_PATHS.
    """
    if not path:
        return False
    # abspath resolves '..' segments against the CWD, giving the real path.
    resolved = os.path.abspath(str(path)).lower()
    for protected in PROTECTED_PATHS:
        if resolved == protected or resolved.startswith(protected + os.sep):
            return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Public validation entry point
# ─────────────────────────────────────────────────────────────────────────────

def validate(action, params):
    """
    Validate an LLM-decided action and its parameters against all safety rules.

    Returns:
        (True,  None)          — safe to proceed
        (False, reason_str)    — blocked; reason_str explains why
    """

    # Rule 1 — Action must be on the allowlist
    if action not in ALLOWED_ACTIONS:
        reason = f"Action '{action}' is not a permitted operation."
        logging.warning(f"[SAFETY] Blocked unknown action: {action}")
        return False, reason

    # Rule 2 — Scan all params for dangerous shell/code patterns
    found_dangerous, detail = _scan_params(params)
    if found_dangerous:
        reason = f"Potentially dangerous content detected ({detail})."
        logging.warning(f"[SAFETY] Blocked due to dangerous content: {detail}")
        return False, reason

    # Rule 3 — Path protection for file/folder operations
    for path_key in ("path", "filename", "folder"):
        raw_path = params.get(path_key, "")
        if raw_path and _is_protected_path(raw_path):
            reason = f"Access to the path '{raw_path}' is restricted for system safety."
            logging.warning(f"[SAFETY] Blocked protected path: {raw_path}")
            return False, reason

    # Rule 4 — App allowlist check
    if action == "open_app":
        requested = params.get("app", "").lower().strip()
        if not requested:
            reason = "No application name was specified."
            logging.warning("[SAFETY] Blocked empty app name.")
            return False, reason
        if not any(allowed in requested or requested in allowed for allowed in ALLOWED_APPS):
            reason = f"The application '{requested}' is not on the approved list."
            logging.warning(f"[SAFETY] Blocked unapproved app: {requested}")
            return False, reason

    return True, None
