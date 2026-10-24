import logging
import database
from command_framework.modules.system_control import SystemController
from command_framework.modules.file_manager import FileManager
from command_framework.modules.reminders import ReminderManager
from command_framework.modules.web_search import WebSearcher
from command_framework.agent.agent_graph import JarvisAgent
from command_framework import safety_guard


class CommandHandler:
    def __init__(self, speak_callback=None):
        """
        speak_callback: optional function(text) used for TTS during approval
                        prompts and by async modules (e.g. timers).
        """
        self.system = SystemController()
        self.files = FileManager()
        self.reminders = ReminderManager(speak_callback=speak_callback)
        self.searcher = WebSearcher()
        self._speak = speak_callback
        logging.basicConfig(level=logging.INFO)
        
        # Initialize LangGraph multi-step agent
        self.agent = JarvisAgent(speak_callback=speak_callback)

    def _describe_action(self, action, params):
        """Build a clear, plain-English description of what is about to happen."""
        content = params.get("content", "")
        content_preview = (content[:80] + "…") if len(content) > 80 else content

        descriptions = {
            "open_app":      f"Open application:  {params.get('app', '?')}",
            "create_note":   f"Create note file:  '{params.get('filename', 'untitled')}.txt'\n"
                             f"             Content: \"{content_preview}\"",
            "modify_note":   f"Modify note file:  '{params.get('filename', 'untitled')}.txt'\n"
                             f"             Append:  \"{params.get('append_text', '')}\"\n"
                             f"             Replace: \"{params.get('find_text', '')}\" -> \"{params.get('replace_text', '')}\"",
            "delete_note":   f"Delete note file:  '{params.get('filename', '')}.txt'",
            "create_folder": f"Create folder at:  {params.get('path', '?')}",
            "create_excel":  f"Create Excel file: '{params.get('filename', 'untitled')}.xlsx'\n"
                             f"             Columns: {params.get('headers', [])}",
            "set_timer":     f"Set timer:         {params.get('seconds', '?')} seconds\n"
                             f"             Alert: \"{params.get('message', '')}\"",
        }
        return descriptions.get(action, f"Execute '{action}' with params: {params}")

    def _request_approval(self, action, params):
        """
        Show the user a clear summary of the pending action and ask for approval.
        Speaks the summary aloud if TTS is available.
        Returns True if approved, False if denied.
        """
        description = self._describe_action(action, params)
        border = "-" * 58

        print(f"\n{border}")
        print("  (!)  JARVIS - ACTION APPROVAL REQUIRED")
        print(border)
        print(f"  Action : {description}")
        print(border)

        # Speak the summary aloud
        if self._speak:
            spoken = description.replace("\n", " ").replace("  ", " ")
            self._speak(f"I want to {spoken}. Do you approve?")

        while True:
            try:
                answer = input("  Approve? [yes / no]: ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print("\n  Approval cancelled.")
                return False

            if answer in ("yes", "y"):
                print(f"  [+]  Approved — executing.\n")
                logging.info(f"User approved action: {action}")
                return True
            elif answer in ("no", "n", "cancel", "deny"):
                print(f"  [-]  Denied — action cancelled.\n")
                logging.info(f"User denied action: {action}")
                return False
            else:
                print("  Please type 'yes' to approve or 'no' to cancel.")

    def _parse_seconds(self, val):
        """Safely parse seconds parameter to an integer."""
        if val is None:
            return 10
        try:
            return int(float(val))
        except (ValueError, TypeError):
            return 10

    def process_command(self, text):
        """
        Processes user query through the LangGraph Multi-Step Agent.
        Returns the final textual response.
        """
        if not text.strip():
            return "I didn't catch that."

        logging.info(f"Processing command via LangGraph Agent: {text}")
        result = self.agent.process_query(text)
        
        # If an approval was needed in CLI mode, handle it interactively
        while result.get("status") == "pending_approval":
            action = result.get("action", "")
            params = result.get("params", {})
            approval_id = result.get("approval_id")
            approved = self._request_approval(action, params)
            result = self.agent.resume_approval(approval_id, approved)

        return result.get("response", "I'm not sure how to help with that.")


if __name__ == "__main__":
    handler = CommandHandler()
    tests = [
        "what time is it and what is today's date",
        "open notepad",
        "delete all files in system32",          # should be blocked
    ]
    for cmd in tests:
        print(f"\n> {cmd}")
        print(f"  Jarvis: {handler.process_command(cmd)}")
