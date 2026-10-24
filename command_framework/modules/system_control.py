import subprocess
from datetime import datetime
import logging


class SystemController:
    def __init__(self):
        # Keyword → Windows executable / shell command
        self.apps = {
            "notepad":       "notepad.exe",
            "calculator":    "calc.exe",
            "browser":       "start chrome",
            "chrome":        "start chrome",
            "explorer":      "explorer.exe",
            "file explorer": "explorer.exe",
            "cmd":           "start cmd",
            "terminal":      "start cmd",
            "command prompt":"start cmd",
            "vscode":        "code",
            "vs code":       "code",
            "word":          "start winword",
            "excel":         "start excel",
            "powerpoint":    "start powerpnt",
            "paint":         "mspaint.exe",
            "task manager":  "taskmgr.exe",
            "control panel": "control",
            "settings":      "start ms-settings:",
            "snipping tool": "snippingtool.exe",
        }

    def get_time(self):
        return f"The current time is {datetime.now().strftime('%I:%M %p')}."

    def get_date(self):
        return f"Today's date is {datetime.now().strftime('%B %d, %Y')}."

    def open_app(self, app_name):
        app_name = app_name.lower().strip()
        if not app_name:
            return "Please specify an application name to open."
        for key, exe in self.apps.items():
            if key in app_name or app_name in key:
                try:
                    subprocess.Popen(exe, shell=True)
                    logging.info(f"Opened app: {key}")
                    return f"Opening {key}."
                except Exception as e:
                    logging.error(f"Failed to open {key}: {e}")
                    return f"I encountered an error trying to open {key}."
        known = ", ".join(self.apps.keys())
        return f"I don't know how to open '{app_name}'. I can open: {known}."

    # ── Backwards-compatible execute() ───────────────────────────────────────
    def execute(self, command):
        if "time" in command:
            return self.get_time()
        elif "date" in command:
            return self.get_date()
        elif "open" in command:
            for app_name in self.apps:
                if app_name in command:
                    return self.open_app(app_name)
            return "I'm not sure which application you want me to open."
        return "System command recognized but not fully implemented."
