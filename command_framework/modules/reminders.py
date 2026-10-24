import threading
import time
import logging
import uuid


class ReminderManager:
    def __init__(self, speak_callback=None):
        """
        speak_callback: optional function(text) that is called when a timer fires.
                        If None, the alert is printed and logged only.
        """
        self.active_reminders = {}  # UUID -> (Thread, start_time, duration, message)
        self._speak = speak_callback

    # ── Internal timer thread ─────────────────────────────────────────────────
    def _timer_thread(self, timer_id, seconds, message):
        slept = 0.0
        # Check every 0.5 seconds to see if the timer was cancelled
        while slept < seconds:
            if timer_id not in self.active_reminders:
                logging.info(f"Timer {timer_id} was cancelled before firing.")
                return
            time.sleep(0.5)
            slept += 0.5

        # Double check if still active before firing
        if timer_id not in self.active_reminders:
            return

        self.active_reminders.pop(timer_id, None)
        logging.info(f"REMINDER FIRED: {message}")
        print(f"\n(!) [JARVIS REMINDER]: {message}\n")
        if self._speak:
            try:
                self._speak(message)
            except Exception as e:
                logging.error(f"TTS error in reminder callback: {e}")

    # ── Public API ────────────────────────────────────────────────────────────
    def set_timer(self, seconds, message="Timer finished!"):
        """Start a background countdown timer that speaks aloud when done."""
        if seconds <= 0:
            return "Please specify a positive duration for the timer."

        timer_id = str(uuid.uuid4())
        
        # Clean up completed threads
        dead_ids = [tid for tid, info in self.active_reminders.items() if not info[0].is_alive()]
        for tid in dead_ids:
            self.active_reminders.pop(tid, None)

        t = threading.Thread(
            target=self._timer_thread,
            args=(timer_id, seconds, message),
            daemon=True,
        )
        self.active_reminders[timer_id] = (t, time.time(), seconds, message)
        t.start()

        # Build a human-readable duration string
        if seconds < 60:
            dur = f"{seconds} second{'s' if seconds != 1 else ''}"
        elif seconds < 3600:
            mins, secs = divmod(seconds, 60)
            dur = f"{mins} minute{'s' if mins != 1 else ''}"
            if secs:
                dur += f" and {secs} second{'s' if secs != 1 else ''}"
        else:
            hrs, rem = divmod(seconds, 3600)
            mins = rem // 60
            dur = f"{hrs} hour{'s' if hrs != 1 else ''}"
            if mins:
                dur += f" and {mins} minute{'s' if mins != 1 else ''}"

        return f"Timer set for {dur}. I'll let you know when it's done."

    def cancel_timer(self, timer_id):
        """Cancel an active timer by removing it from the dictionary."""
        if timer_id in self.active_reminders:
            self.active_reminders.pop(timer_id, None)
            return True
        return False

    def list_timers(self):
        """Return list of active timers with remaining time."""
        now = time.time()
        timers_list = []
        
        # Clean up completed threads first
        dead_ids = [tid for tid, info in self.active_reminders.items() if not info[0].is_alive()]
        for tid in dead_ids:
            self.active_reminders.pop(tid, None)

        for tid, info in self.active_reminders.items():
            t, start_time, duration, message = info
            elapsed = now - start_time
            remaining = max(0, int(duration - elapsed))
            timers_list.append({
                "id": tid,
                "seconds_remaining": remaining,
                "duration": duration,
                "message": message
            })
        return timers_list

    # ── Backwards-compatible execute() ───────────────────────────────────────
    def execute(self, command):
        return self.set_timer(10, "Timer finished!")
