import os
import sqlite3
import logging
from datetime import datetime

# Determine project root and database path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(PROJECT_ROOT, "jarvis_memory.db")

def get_connection():
    """Return a connection to the SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def initialize_db():
    """Initialize the database tables if they do not exist."""
    try:
        with get_connection() as conn:
            # Create chat_history table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender TEXT NOT NULL,
                    text TEXT NOT NULL,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.commit()
        logging.info("SQLite database initialized successfully.")
    except Exception as e:
        logging.error(f"Error initializing SQLite database: {e}")

def add_chat_message(sender, text):
    """Add a message to the chat history."""
    if not text or not text.strip():
        return
    try:
        timestamp = datetime.now().isoformat()
        with get_connection() as conn:
            conn.execute(
                "INSERT INTO chat_history (sender, text, timestamp) VALUES (?, ?, ?)",
                (sender, text.strip(), timestamp)
            )
            conn.commit()
    except Exception as e:
        logging.error(f"Error adding chat message to history: {e}")

def get_chat_history(limit=10):
    """Retrieve the last N messages from chat history."""
    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT sender, text, timestamp FROM chat_history ORDER BY id DESC LIMIT ?",
                (limit,)
            )
            rows = cursor.fetchall()
            # Return in chronological order (oldest first)
            return [{"sender": r["sender"], "text": r["text"], "timestamp": r["timestamp"]} for r in reversed(rows)]
    except Exception as e:
        logging.error(f"Error retrieving chat history: {e}")
        return []

def clear_chat_history():
    """Clear all records from chat history."""
    try:
        with get_connection() as conn:
            conn.execute("DELETE FROM chat_history")
            conn.commit()
        logging.info("Chat history cleared.")
    except Exception as e:
        logging.error(f"Error clearing chat history: {e}")

# Automatically initialize on module import
initialize_db()
