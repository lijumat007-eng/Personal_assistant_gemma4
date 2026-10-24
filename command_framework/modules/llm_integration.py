import json
import logging
import re
import os
import sys
import requests
import google.generativeai as genai

# Ensure project root is in sys.path so we can import database
_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.normpath(os.path.join(_MODULE_DIR, "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import database

# ─────────────────────────────────────────────────────────────────────────────
# System prompt — tells Gemini about every available tool and how to respond
# ─────────────────────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = """\
You are Jarvis, a personal desktop assistant running on Windows.
The user has given you a voice or text command. The command may be in English, Malayalam, or a mix of both (Manglish).
Your job is to decide which action to perform and extract the required parameters. Regardless of the language of the user's input, you MUST extract parameters and define the JSON action in English.

YOU MUST RESPOND WITH ONLY A SINGLE VALID JSON OBJECT — no explanation, no markdown, no extra text.

Available actions:

1. open_app       – Open an application
   {"action": "open_app", "params": {"app": "<notepad|calculator|browser|explorer|cmd|vscode|word|excel|powerpoint|paint>"}}

2. get_time       – Tell the current time
   {"action": "get_time", "params": {}}

3. get_date       – Tell today's date
   {"action": "get_date", "params": {}}

4. create_note    – Create a text note file with content
   {"action": "create_note", "params": {"filename": "<name without extension>", "content": "<full note body>"}}

5. read_note      – Read a saved note (leave filename empty for most recent)
   {"action": "read_note", "params": {"filename": "<name or empty string>"}}

6. create_folder  – Create a new folder on disk
   {"action": "create_folder", "params": {"path": "<absolute or relative path>"}}

7. create_excel   – Generate an Excel (.xlsx) file with data
   {"action": "create_excel", "params": {"filename": "<name>", "headers": ["Col1", "Col2"], "rows": [["val1", "val2"]]}}

8. list_files     – List files in a directory
   {"action": "list_files", "params": {"path": "<folder path, or 'notes' for the notes folder>"}}

9. set_timer      – Set a countdown timer
   {"action": "set_timer", "params": {"seconds": <integer>, "message": "<what to say aloud when done>"}}

10. chat          – Answer a general question or hold a conversation
    {"action": "chat", "params": {"response": "<your full answer to the user>"}}

User command: """


class LLMIntegration:
    def __init__(self):
        # Determine root directory to locate config.json
        root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.config_path = os.path.join(root_dir, "config.json")
        
        self.provider = "ollama"
        self.model_name = "qwen2.5:3b"
        self.ollama_host = "http://localhost:11434"
        
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r") as f:
                    config = json.load(f)
                    self.provider = config.get("llm_provider", "ollama")
                    if self.provider == "gemini":
                        self.model_name = config.get("gemini", {}).get("model_name", "gemini-2.5-flash")
                    elif self.provider == "ollama":
                        self.model_name = config.get("ollama", {}).get("model_name", "qwen2.5:3b")
                        self.ollama_host = config.get("ollama", {}).get("host", "http://localhost:11434")
            except Exception as e:
                logging.error(f"Error reading config.json, using defaults: {e}")

        if self.provider == "gemini":
            self._init_gemini()
        else:
            self._init_ollama()

    def _init_gemini(self):
        self.api_key = os.environ.get("GEMINI_API_KEY", "")
        
        # QOL: Try to load GEMINI_API_KEY from key.txt if not in environment
        if not self.api_key:
            root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            key_txt_path = os.path.join(root_dir, "key.txt")
            if os.path.exists(key_txt_path):
                try:
                    with open(key_txt_path, "r") as f:
                        self.api_key = f.read().strip()
                        if self.api_key:
                            os.environ["GEMINI_API_KEY"] = self.api_key
                            logging.info("Gemini API key loaded from key.txt")
                except Exception as e:
                    logging.error(f"Error reading key.txt: {e}")
                    
        # Fallback prompting if key is still missing
        if not self.api_key:
            print("\n" + "="*50)
            print("[Jarvis] GEMINI_API_KEY environment variable is not set.")
            self.api_key = input("Please paste your Google Gemini API key here: ").strip()
            os.environ["GEMINI_API_KEY"] = self.api_key
            print("="*50 + "\n")
            
        genai.configure(api_key=self.api_key)
        
        # Configure the routing model to strictly return JSON
        self.model = genai.GenerativeModel(
            self.model_name,
            generation_config={"response_mime_type": "application/json"}
        )
        
        # Standard model for normal text chatting
        self.chat_model = genai.GenerativeModel(self.model_name)

    def _init_ollama(self):
        # Local Ollama client setup (requests are sent dynamically to the host endpoint)
        pass

    def _lazy_init_gemini(self):
        """
        Lazily initialize Gemini models if needed as a fallback.
        """
        if hasattr(self, "model") and self.model is not None:
            return True
            
        self.api_key = os.environ.get("GEMINI_API_KEY", "")
        if not self.api_key:
            root_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            key_txt_path = os.path.join(root_dir, "key.txt")
            if os.path.exists(key_txt_path):
                try:
                    with open(key_txt_path, "r") as f:
                        self.api_key = f.read().strip()
                        if self.api_key:
                            os.environ["GEMINI_API_KEY"] = self.api_key
                            logging.info("Gemini API key loaded from key.txt for fallback")
                except Exception as e:
                    logging.error(f"Error reading key.txt: {e}")
                    
        if not self.api_key:
            logging.error("Gemini API key is not configured. Fallback unavailable.")
            return False
            
        try:
            genai.configure(api_key=self.api_key)
            self.model = genai.GenerativeModel(
                "gemini-2.5-flash",
                generation_config={"response_mime_type": "application/json"}
            )
            self.chat_model = genai.GenerativeModel("gemini-2.5-flash")
            logging.info("Gemini fallback initialized successfully.")
            return True
        except Exception as e:
            logging.error(f"Failed to initialize Gemini fallback: {e}")
            return False

    # ── Model warm-up ─────────────────────────────────────────────────────────
    def warm_up(self):
        """
        Send a trivial prompt to initialize the connection.
        """
        if self.provider == "gemini":
            print("[Jarvis] Connecting to Google Gemini API, please wait…")
            try:
                self.chat_model.generate_content("hi")
                print("[Jarvis] Connection established. Gemini API is ready.")
                return True
            except Exception as e:
                logging.error(f"Gemini warm-up error: {e}")
                print("[Jarvis] Warning: Failed to connect to Gemini API. Please check your internet connection or API key.")
                return False
        else:
            print(f"[Jarvis] Pre-warming local Ollama model '{self.model_name}'…")
            try:
                url = f"{self.ollama_host}/api/generate"
                payload = {
                    "model": self.model_name,
                    "prompt": "hi",
                    "stream": False
                }
                response = requests.post(url, json=payload, timeout=10)
                if response.status_code == 200:
                    print(f"[Jarvis] Connection established. Local Ollama model '{self.model_name}' is ready.")
                    return True
                else:
                    print(f"[Jarvis] Warning: Local Ollama model '{self.model_name}' failed to respond. Attempting Gemini fallback...")
                    if self._lazy_init_gemini():
                        try:
                            self.chat_model.generate_content("hi")
                            print("[Jarvis] Gemini fallback connection established. Gemini API is ready.")
                            return True
                        except Exception as ge:
                            logging.error(f"Gemini fallback warm-up error: {ge}")
                    return False
            except Exception as e:
                logging.error(f"Ollama warm-up error: {e}")
                print(f"[Jarvis] Warning: Failed to connect to Ollama at {self.ollama_host}. Attempting Gemini fallback...")
                if self._lazy_init_gemini():
                    try:
                        self.chat_model.generate_content("hi")
                        print("[Jarvis] Gemini fallback connection established. Gemini API is ready.")
                        return True
                    except Exception as ge:
                        logging.error(f"Gemini fallback warm-up error: {ge}")
                return False

    # ── Intent router ─────────────────────────────────────────────────────────
    def route(self, user_text):
        """
        Ask LLM to decide what action to perform and return a structured dict.
        """
        # Fetch last 6 messages from database memory for context
        history_list = database.get_chat_history(limit=6)
        history_str = ""
        if history_list:
            history_str = "Conversation history so far:\n"
            for msg in history_list:
                sender_label = "User" if msg["sender"] == "user" else "Jarvis"
                history_str += f"{sender_label}: {msg['text']}\n"
            history_str += "\n"

        prompt = _SYSTEM_PROMPT + history_str + f"User command: {user_text}"
        logging.info(f"LLM routing: {user_text}")

        raw = None
        if self.provider == "gemini":
            try:
                response = self.model.generate_content(prompt)
                raw = response.text
            except Exception as e:
                logging.error(f"Gemini API error: {e}")
        else:
            try:
                url = f"{self.ollama_host}/api/generate"
                payload = {
                    "model": self.model_name,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json"
                }
                response = requests.post(url, json=payload, timeout=20)
                if response.status_code == 200:
                    raw = response.json().get("response", "").strip()
                else:
                    logging.error(f"Ollama returned status {response.status_code}: {response.text}")
            except Exception as e:
                logging.error(f"Ollama API error: {e}")
            
            # Fallback to Gemini if Ollama routing failed
            if not raw:
                logging.warning("Ollama routing failed. Attempting Gemini cloud fallback...")
                if self._lazy_init_gemini():
                    try:
                        response = self.model.generate_content(prompt)
                        raw = response.text
                        logging.info("Gemini fallback routing successful.")
                    except Exception as ge:
                        logging.error(f"Gemini fallback routing error: {ge}")

        if not raw:
            return {
                "action": "chat",
                "params": {"response": "I am having trouble connecting to both the local Ollama and Gemini cloud models. Please check your connections."},
            }

        # 1. Try direct JSON parse
        try:
            parsed = json.loads(raw)
            if "action" in parsed and "params" in parsed:
                logging.info(f"LLM decided action: {parsed['action']}")
                return parsed
        except json.JSONDecodeError:
            pass

        # 2. LLM sometimes wraps output in markdown fences — strip and retry
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group())
                if "action" in parsed and "params" in parsed:
                    logging.info(f"LLM decided action (extracted): {parsed['action']}")
                    return parsed
            except json.JSONDecodeError:
                pass

        # 3. Treat the raw text as a conversational answer fallback
        logging.warning(f"Could not parse LLM JSON; falling back to chat. Raw: {raw[:300]}")
        return {
            "action": "chat",
            "params": {"response": raw.strip() or "I'm not sure how to handle that."},
        }

    def chat(self, user_text):
        """Plain conversational response with no tool routing."""
        # Fetch last 8 messages from database memory for context
        history_list = database.get_chat_history(limit=8)
        history_str = ""
        if history_list:
            for msg in history_list:
                sender_label = "User" if msg["sender"] == "user" else "Jarvis"
                history_str += f"{sender_label}: {msg['text']}\n"
        
        chat_prompt = (
            "You are Jarvis, a personal desktop assistant running on Windows. "
            "Engage in a friendly, conversational reply to the user. "
            "Use the conversation history context to answer follow-up questions accurately.\n\n"
            f"{history_str}User: {user_text}\nJarvis:"
        )

        if self.provider == "gemini":
            try:
                response = self.chat_model.generate_content(chat_prompt)
                return response.text
            except Exception as e:
                logging.error(f"Gemini error during chat: {e}")
                return "I encountered an error while trying to generate a response in the cloud."
        else:
            response_text = None
            try:
                url = f"{self.ollama_host}/api/generate"
                payload = {
                    "model": self.model_name,
                    "prompt": chat_prompt,
                    "stream": False
                }
                response = requests.post(url, json=payload, timeout=20)
                if response.status_code == 200:
                    response_text = response.json().get("response", "").strip()
                else:
                    logging.error(f"Ollama returned status {response.status_code} during chat.")
            except Exception as e:
                logging.error(f"Ollama error during chat: {e}")

            # Fallback to Gemini
            if not response_text:
                logging.warning("Ollama chat failed. Attempting Gemini cloud fallback...")
                if self._lazy_init_gemini():
                    try:
                        response = self.chat_model.generate_content(chat_prompt)
                        response_text = response.text
                        logging.info("Gemini fallback chat successful.")
                    except Exception as ge:
                        logging.error(f"Gemini fallback chat error: {ge}")
            
            return response_text or "I encountered an error trying to connect to the local Ollama and Gemini cloud servers."
