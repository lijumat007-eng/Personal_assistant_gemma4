import pyttsx3
import os
import sys
import json
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from command_framework.command_handler import CommandHandler

# ---------------------------------------------------------------------------
# Helper: TTS engine (shared by both modes)
# ---------------------------------------------------------------------------
_tts_engine = pyttsx3.init()

def text_to_speech(text):
    """Speak the given text aloud."""
    _tts_engine.say(text)
    _tts_engine.runAndWait()


# ---------------------------------------------------------------------------
# Voice-mode helpers (Google Speech API via sounddevice)
# ---------------------------------------------------------------------------
def _load_voice_components():
    """Initialize offline WhisperModel."""
    print("\n[Jarvis] Initializing Whisper model...")
    print("[Jarvis] (Note: This may take a minute on the first execution to download the ~75MB model)")
    # Using tiny (multilingual) for fast CPU inference. compute_type="int8" optimizes CPU usage.
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    return model

def recognize_speech(model):
    """
    Records audio using sounddevice and numpy to detect voice activity,
    then transcribes it locally using the offline Whisper model.
    """
    samplerate = 16000
    THRESHOLD = 0.01  # Volume threshold for voice activity
    SILENCE_LIMIT = 1.5  # Seconds of silence before we consider the sentence finished
    
    print("Listening... (speak now, or press Ctrl+C to type instead)")
    
    audio_data = []
    is_speaking = False
    silence_time = 0.0
    
    chunk_duration = 0.1
    chunk_samples = int(samplerate * chunk_duration)
    
    try:
        # We read raw int16 data directly
        with sd.InputStream(samplerate=samplerate, channels=1, dtype='int16') as stream:
            while True:
                chunk, overflowed = stream.read(chunk_samples)
                
                # Calculate volume (Root Mean Square)
                # Convert to float for calculation to avoid overflow
                chunk_float = chunk.astype(np.float32)
                volume = np.sqrt(np.mean(chunk_float**2)) / 32768.0
                
                if volume > THRESHOLD:
                    is_speaking = True
                    silence_time = 0.0
                
                if is_speaking:
                    audio_data.append(chunk)
                    if volume <= THRESHOLD:
                        silence_time += chunk_duration
                        if silence_time > SILENCE_LIMIT:
                            break # User stopped speaking
                            
        if not audio_data:
            return ""
            
        # Concatenate all chunks and flatten
        recording_int16 = np.concatenate(audio_data, axis=0).flatten()
        
        # Convert to float32 and normalize to [-1.0, 1.0] for Whisper
        recording_float32 = recording_int16.astype(np.float32) / 32768.0
        
        try:
            segments, info = model.transcribe(recording_float32, beam_size=5)
            text = " ".join([segment.text for segment in segments]).strip()
            print(f"Recognized: {text}")
            return text
        except Exception as e:
            print(f"[ERROR] Whisper transcription failed: {e}")
            return ""
            
    except KeyboardInterrupt:
        raise

def _is_shutdown_command(command_text):
    """Return True only for explicit shutdown commands."""
    normalized = " ".join(command_text.lower().strip().split())
    return normalized in {"shutdown", "exit", "quit", "goodbye", "bye"}


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # --- Check and prompt for LLM provider configuration ---
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if not os.path.exists(config_path):
        print("=" * 50)
        print("       JARVIS - FIRST TIME CONFIGURATION")
        print("=" * 50)
        print("\nChoose your preferred Large Language Model (LLM) brain:")
        print("  [1]  Google Gemini (Cloud) - Requires API key, fast, highly capable")
        print("  [2]  Local Ollama / Gemma (Offline) - Runs locally, free, private")
        print()
        while True:
            llm_choice = input("Enter 1 or 2: ").strip()
            if llm_choice in ("1", "2"):
                break
            print("  Please enter 1 for Gemini or 2 for Ollama.")
            
        config_data = {
            "llm_provider": "gemini" if llm_choice == "1" else "ollama",
            "gemini": {
                "model_name": "gemini-2.5-flash"
            },
            "ollama": {
                "model_name": "gemma4",
                "host": "http://localhost:11434"
            }
        }
        try:
            with open(config_path, "w") as f:
                json.dump(config_data, f, indent=2)
            print("[Jarvis] Configuration saved to config.json.\n")
        except Exception as e:
            print(f"[ERROR] Could not save config.json: {e}")

    handler = CommandHandler(speak_callback=text_to_speech)

    # ── Mode selection ──────────────────────────────────────────────────────
    print("=" * 50)
    print("       Welcome to JARVIS Personal Assistant")
    print("=" * 50)
    print("\nHow would you like to interact?")
    print("  [1]  Voice mode  (speak your commands via microphone)")
    print("  [2]  Text mode   (type your commands in the terminal)")
    print()

    while True:
        choice = input("Enter 1 or 2: ").strip()
        if choice in ("1", "2"):
            break
        print("  Please enter 1 for voice or 2 for text.")

    use_voice = choice == "1"

    if use_voice:
        print("\n[Voice mode selected] Loading offline Whisper model...")
        recognizer = _load_voice_components()
        print("[Ready] Microphone ready.")
    else:
        print("\n[Text mode selected] No microphone required.")

    print()
    text_to_speech("Jarvis is online and ready.")
    print("Jarvis: Online. Type or say 'exit' to quit.\n")

    # Pre-warm the LLM so the first user command doesn't time out
    handler.llm.warm_up()
    print()

    # ── Main interaction loop ───────────────────────────────────────────────
    while True:
        print("--- Waiting for input ---")
        command_text = ""

        if use_voice:
            try:
                command_text = recognize_speech(recognizer)
            except KeyboardInterrupt:
                print("\n[Voice interrupted] Switching to text input for this turn.")
                command_text = input("You: ").strip()

            # Fallback to text if Google returned nothing
            if not command_text:
                continue
        else:
            command_text = input("You: ").strip()

        if not command_text:
            continue

        # Shutdown check

        if _is_shutdown_command(command_text):
            print("Jarvis: Shutting down systems. Goodbye!")
            text_to_speech("Shutting down systems. Goodbye!")
            break

        # Process and respond
        response = handler.process_command(command_text)
        print(f"Jarvis: {response}")
        text_to_speech(response)
        print()
